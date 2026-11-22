/**
 * Phase 7 tests against a real PostgreSQL: WebRTC calls (LiveKit tokens, webhooks and the
 * re-validation of connected people) and the consultation schedule. Named after the attacks
 * they stop: IDOR on rooms, staying in a room after losing access, forged SFU webhooks,
 * booking around the DM rules, minors, overbooking and tampering at rest.
 *
 *   RUN_DB_TESTS=1 DATABASE_URL=... pnpm --filter @puet/api test
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@puet/database';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule, REDIS } from '../../src/app.module';
import { OIDC_PROVIDER, type IdTokenClaims, type OidcProvider } from '../../src/auth/oidc.service';
import { APP_CONFIG, loadConfig } from '../../src/config/config';
import { FakeScanner, MALWARE_SCANNER } from '../../src/files/malware-scanner';
import { MemoryObjectStore, OBJECT_STORE } from '../../src/files/object-store';
import { sign } from '../../src/integrations/hmac';
import { DIGEST_STORE, MemoryDigestStore } from '../../src/notifications/digest.store';
import { FakeMediaServer, MEDIA_SERVER } from '../../src/calls/media-server';
import { CallsService } from '../../src/calls/calls.service';
import { CA_LOADER } from '../../src/pki/pki.service';
import { createRootCa, loadCa, type CaMaterial } from '../../src/pki/x509';
import { MemoryRealtimeBus, REALTIME_BUS } from '../../src/realtime/realtime.bus';
import { MemorySessionStore, SESSION_STORE } from '../../src/session/session.store';

const enabled = process.env.RUN_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const WEB = 'https://pulse.test';
const sfx = randomUUID().slice(0, 8).toUpperCase();

const clients = {
  hr: { id: randomUUID(), secret: 'h'.repeat(40), tenantCode: 'PUET_MAIN', kinds: ['HR_STAFF', 'TEACHING_LOAD', 'OFFBOARDING'] },
  edebo: { id: randomUUID(), secret: 'e'.repeat(40), tenantCode: 'PUET_MAIN', kinds: ['EDEBO_STUDENTS'] },
  lyceum: { id: randomUUID(), secret: 'l'.repeat(40), tenantCode: 'PUET_LYCEUM', kinds: ['EDEBO_STUDENTS'] },
};

let nextClaims: IdTokenClaims = { sub: 'nobody' };
const fakeOidc: OidcProvider = {
  authorizationUrl: async (p) => `https://sso.test/auth?state=${p.state}${p.acr ? `&acr_values=${p.acr}` : ''}`,
  exchange: async () => nextClaims,
  endSessionUrl: async () => undefined,
};

describe.skipIf(!enabled)('Phase 7 calls and consultations (PostgreSQL)', () => {
  let app: INestApplication;
  let base: string;
  let ca: CaMaterial;
  const store = new MemoryObjectStore();
  const prisma = new PrismaClient();
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let courseChannelId: string;
  let councilId: string;
  const media = new FakeMediaServer();
  let calls: CallsService;
  let tenantId: string;
  const bus = new MemoryRealtimeBus();

  async function http(path: string, init: RequestInit & { cookie?: string } = {}) {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set('cookie', init.cookie);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (init.method && init.method !== 'GET') headers.set('origin', WEB);
    return fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' });
  }
  const as = (who: string) => ({
    get: (path: string) => http(path, { cookie: cookies[who]! }),
    post: (path: string, body: unknown = {}) => http(path, { method: 'POST', cookie: cookies[who]!, body: JSON.stringify(body) }),
    patch: (path: string, body: unknown) => http(path, { method: 'PATCH', cookie: cookies[who]!, body: JSON.stringify(body) }),
    del: (path: string) => http(path, { method: 'DELETE', cookie: cookies[who]! }),
    upload: (channelId: string, bytes: Buffer, name: string) =>
      http(`/channels/${channelId}/files`, {
        method: 'POST',
        cookie: cookies[who]!,
        body: bytes,
        headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) },
      }),
  });

  async function webhook(client: keyof typeof clients, path: string, payload: unknown) {
    const body = JSON.stringify(payload);
    const t = Math.floor(Date.now() / 1000);
    const res = await fetch(`${base}/integrations/${path}`, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-puet-client': client,
        'x-puet-signature': sign(clients[client].secret, t, body),
        'idempotency-key': randomUUID(),
      },
    });
    expect(res.status).toBe(200);
  }

  async function login(who: string, claims: IdTokenClaims) {
    nextClaims = claims;
    let res = await http('/auth/login?returnTo=/chats');
    let state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    res = await http(`/auth/callback?code=c&state=${state}`);
    const location = res.headers.get('location')!;
    if (location.startsWith('https://sso.test/')) {
      state = new URL(location).searchParams.get('state')!;
      res = await http(`/auth/callback?code=c&state=${state}`);
    }
    const sc = res.headers.get('set-cookie');
    if (!sc) throw new Error(`login failed for ${who}`);
    cookies[who] = sc.split(';')[0]!;
  }

  beforeAll(async () => {
    const root = await createRootCa({ commonName: 'PUET Internal CA (test)', years: 10 });
    ca = await loadCa(root.certificatePem, root.privateKeyPem);
    const config = loadConfig({
      NODE_ENV: 'test',
      WEB_ORIGIN: WEB,
      REDIS_URL: 'redis://unused',
      OIDC_ISSUER_URL: 'https://sso.test/realms/puet',
      OIDC_CLIENT_ID: 'pulse',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_REDIRECT_URI: `${WEB}/api/auth/callback`,
      INTEGRATION_CLIENTS: JSON.stringify(clients),
      JOBS_ENABLED: 'false',
      VERIFY_CODE_SECRET: 'v'.repeat(48),
      FILE_SCAN_INLINE: 'false',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(REDIS)
      .useValue({})
      .overrideProvider(SESSION_STORE)
      .useValue(new MemorySessionStore())
      .overrideProvider(OIDC_PROVIDER)
      .useValue(fakeOidc)
      .overrideProvider(REALTIME_BUS)
      .useValue(bus)
      .overrideProvider(DIGEST_STORE)
      .useValue(new MemoryDigestStore())
      .overrideProvider(OBJECT_STORE)
      .useValue(store)
      .overrideProvider(MALWARE_SCANNER)
      .useValue(new FakeScanner())
      .overrideProvider(CA_LOADER)
      .useValue(async () => ca)
      .overrideProvider(MEDIA_SERVER)
      .useValue(media)
      .compile();
    calls = moduleRef.get(CallsService);
    app = moduleRef.createNestApplication({ rawBody: true, logger: ['error'] });
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    await webhook('hr', 'hr/staff', {
      records: [
        {
          hrId: `L7-${sfx}`,
          corporateId: `L7-${sfx}`,
          email: `l-${sfx}@puet.test`,
          fullNameUk: `Викладачка П'ята ${sfx}`,
          phone: '+380501234567',
          position: 'Доцент',
          primaryDepartmentCode: 'COMPUTER_SCIENCE_IT',
          roles: [{ role: 'LECTURER' }],
        },
        { hrId: `H7-${sfx}`, corporateId: `H7-${sfx}`, email: `h-${sfx}@puet.test`, fullNameUk: `Завідувач П'ятий ${sfx}`, position: 'Завідувач кафедри', primaryDepartmentCode: 'LAW', roles: [{ role: 'DEPARTMENT_HEAD', departmentCode: 'LAW' }] },
      ],
    });
    const student = (n: string, group: string) => ({
      edeboId: `${n}-${sfx}`,
      corporateId: `${n}-${sfx}`,
      email: `${n.toLowerCase()}-${sfx}@puet.test`,
      fullNameUk: `Студент ${n} ${sfx}`,
      birthDate: '2004-05-01',
      educationLevel: 'BACHELOR',
      instituteCode: 'NNI_DAYTIME',
      groupCode: group,
      courseYear: 2,
    });
    await webhook('edebo', 'edebo/students', { records: [student('S1', `KN7-${sfx}`), student('S2', `KN7-${sfx}`), student('S3', `EK7-${sfx}`)] });
    await webhook('lyceum', 'edebo/students', {
      records: [{ edeboId: `P-${sfx}`, corporateId: `P-${sfx}`, email: `p-${sfx}@puet.test`, fullNameUk: `Учень Ліцею ${sfx}`, educationLevel: 'LYCEUM', groupCode: `10C-${sfx}`, courseYear: 10 }],
    });
    await webhook('hr', 'teaching-load', {
      semester: { code: `S7-${sfx}`, startsOn: '2026-09-01', endsOn: '2027-01-31', isCurrent: true },
      offerings: [
        {
          externalId: `CO7-${sfx}`,
          departmentCode: 'COMPUTER_SCIENCE_IT',
          discipline: { code: `NET-${sfx}`, nameUk: 'Комп\'ютерні мережі', nameEn: 'Computer networks' },
          lecturerHrIds: [`L7-${sfx}`],
          groupCodes: [`KN7-${sfx}`],
        },
      ],
    });
    for (const n of ['S1', 'S2', 'S3', 'P']) ids[n] = (await prisma.user.findUniqueOrThrow({ where: { edeboId: `${n}-${sfx}` } })).id;
    ids.L = (await prisma.user.findUniqueOrThrow({ where: { hrId: `L7-${sfx}` } })).id;
    ids.H = (await prisma.user.findUniqueOrThrow({ where: { hrId: `H7-${sfx}` } })).id;
    courseChannelId = (await prisma.courseOffering.findFirstOrThrow({ where: { externalId: `CO7-${sfx}` }, include: { channel: true } })).channel!.id;
    tenantId = (await prisma.user.findUniqueOrThrow({ where: { id: ids.L } })).tenantId;
    // A room with mandatory E2EE (like the Psychological Service): no calls through the SFU.
    councilId = (
      await prisma.channel.create({
        data: {
          tenantId,
          type: 'TRUST_ROOM',
          e2eeMode: 'MANDATORY',
          confidential: true,
          nameUk: `Психологічна служба ${sfx}`,
          members: {
            create: [
              { userId: ids.L!, role: 'OWNER' },
              { userId: ids.S1!, role: 'MEMBER' },
            ],
          },
        },
      })
    ).id;
    for (const n of ['S1', 'S2', 'S3', 'L', 'H', 'P']) await login(n, { sub: `sub-${n}-${sfx}`, email: `${n.toLowerCase()}-${sfx}@puet.test`, amr: ['pwd'] });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });



  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  const json = async <T>(res: Response) => (await res.json()) as T;
  type Slot = { id: string; booked: number; bookable: boolean; myBooking: { topic: string | null } | null; bookings: { studentId: string; topic: string | null }[] | null; status: string; callId: string | null };
  type Join = { callId: string; url: string; token: string; canPublish: boolean };
  type Call = { id: string; messageId: string | null; endedAt: string | null; participants: string[] };
  const roomOf = async (callId: string) => (await prisma.call.findUniqueOrThrow({ where: { id: callId } })).roomName;
  async function sfuWebhook(payload: unknown, signature = media.webhookSecret) {
    return fetch(`${base}/calls/livekit/webhook`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', authorization: signature },
    });
  }

  // ── Calls in channels ───────────────────────────

  it('course channel: the lecturer starts the call, members get tokens, outsiders do not (IDOR)', async () => {
    expect((await as('S1').post(`/channels/${courseChannelId}/calls`)).status).toBe(403);
    const res = await as('L').post(`/channels/${courseChannelId}/calls`);
    expect(res.status).toBe(201);
    const call = await json<Call>(res);
    // One live call per channel: pressing "call" again returns the same one.
    expect((await json<Call>(await as('L').post(`/channels/${courseChannelId}/calls`))).id).toBe(call.id);
    // The timeline shows it as a message without text.
    const msg = await prisma.message.findUniqueOrThrow({ where: { id: call.messageId! } });
    expect(msg.body).toBeNull();
    expect(bus.sent.some((e) => e.kind === 'emit' && e.event === 'message.new' && (e.payload as { callId?: string }).callId === call.id)).toBe(true);

    const join = await json<Join>(await as('S1').post(`/calls/${call.id}/join`));
    expect(join.url).toBe('wss://sfu.test');
    expect(join.canPublish).toBe(true);
    const grant = media.grants.at(-1)!;
    expect(grant).toMatchObject({ identity: ids.S1, room: await roomOf(call.id), canPublish: true, ttlSeconds: 300 });
    // The room name says nothing about the channel or its people.
    expect(grant.room).toMatch(/^pulse-[0-9a-f]{32}$/);

    // IDOR: a student of another group cannot read or join the call by id.
    expect((await as('S3').post(`/calls/${call.id}/join`)).status).toBe(403);
    expect((await as('S3').get(`/calls/${call.id}`)).status).toBe(403);

    // Read-only members watch and listen, they do not publish.
    await prisma.channelMember.update({ where: { channelId_userId: { channelId: courseChannelId, userId: ids.S2! } }, data: { role: 'READ_ONLY' } });
    expect((await json<Join>(await as('S2').post(`/calls/${call.id}/join`))).canPublish).toBe(false);
    expect(media.grants.at(-1)!.canPublish).toBe(false);
    await prisma.channelMember.update({ where: { channelId_userId: { channelId: courseChannelId, userId: ids.S2! } }, data: { role: 'MEMBER' } });
  });

  it('forged SFU webhooks are refused; joins are logged and intruders removed', async () => {
    const call = await json<Call>(await as('L').post(`/channels/${courseChannelId}/calls`));
    const room = await roomOf(call.id);
    expect((await sfuWebhook({ event: 'participant_joined', room, identity: ids.S3 }, 'forged')).status).toBe(401);
    expect((await sfuWebhook({ event: 'room_finished', room }, '')).status).toBe(401);

    expect((await sfuWebhook({ event: 'participant_joined', room, identity: ids.S1 })).status).toBe(200);
    // Someone who is not allowed in (e.g. a leaked token): removed on entry, not logged as a participant.
    expect((await sfuWebhook({ event: 'participant_joined', room, identity: ids.S3 })).status).toBe(200);
    expect(media.removed).toContainEqual({ room, identity: ids.S3 });
    expect((await json<Call>(await as('S1').get(`/calls/${call.id}`))).participants).toEqual([ids.S1]);
    // The participation log cannot be rewritten.
    await expect(prisma.$executeRaw`DELETE FROM call_participants WHERE call_id = ${call.id}::uuid`).rejects.toThrow();
  });

  it('losing access removes a person from the room within one re-validation', async () => {
    const call = await json<Call>(await as('L').post(`/channels/${courseChannelId}/calls`));
    const room = await roomOf(call.id);
    for (const who of ['L', 'S1', 'S2']) media.connect(room, ids[who]!);
    media.connect(room, 'not-a-user');
    await prisma.channelMember.delete({ where: { channelId_userId: { channelId: courseChannelId, userId: ids.S2! } } });
    const r = await calls.revalidate();
    expect(r.removed).toBeGreaterThanOrEqual(2);
    expect(await media.participants(room)).toEqual(expect.arrayContaining([ids.L, ids.S1]));
    expect(await media.participants(room)).not.toContain(ids.S2);
    expect(await media.participants(room)).not.toContain('not-a-user');
    await prisma.channelMember.create({ data: { channelId: courseChannelId, userId: ids.S2!, role: 'MEMBER', source: 'AUTO' } });
  });

  it('only the starter or a moderator ends a call; an ended call is final', async () => {
    const call = await json<Call>(await as('L').post(`/channels/${courseChannelId}/calls`));
    expect((await as('S1').post(`/calls/${call.id}/end`)).status).toBe(403);
    const ended = await json<Call>(await as('L').post(`/calls/${call.id}/end`));
    expect(ended.endedAt).not.toBeNull();
    expect(media.closed).toContain(await roomOf(call.id));
    expect((await as('S1').post(`/calls/${call.id}/join`)).status).toBe(409);
    await expect(prisma.$executeRaw`UPDATE calls SET ended_at = NULL WHERE id = ${call.id}::uuid`).rejects.toThrow();
    // A new call can be started afterwards.
    expect((await json<Call>(await as('L').post(`/channels/${courseChannelId}/calls`))).id).not.toBe(call.id);
  });

  it('no calls in rooms with mandatory E2EE; direct chats can call', async () => {
    expect((await as('S1').post(`/channels/${councilId}/calls`)).status).toBe(403);
    const dm = await json<{ channelId: string }>(await as('L').post(`/users/${ids.S1}/direct`));
    const res = await as('S1').post(`/channels/${dm.channelId}/calls`);
    expect(res.status).toBe(201);
    const call = await json<Call>(res);
    expect((await as('L').post(`/calls/${call.id}/join`)).status).toBe(200);
    expect((await as('S2').post(`/calls/${call.id}/join`)).status).toBe(403);
  });

  // ── Consultation schedule ───────────────────────────

  it('only teaching staff publish slots; times, places and overlaps are checked', async () => {
    const slot = { startsAt: inMinutes(24 * 60), durationMinutes: 30, mode: 'ONLINE', capacity: 2 };
    expect((await as('S1').post('/consultations/slots', slot)).status).toBe(403);
    expect((await as('L').post('/consultations/slots', { ...slot, mode: 'OFFLINE' })).status).toBe(400);
    expect((await as('L').post('/consultations/slots', { ...slot, location: 'ауд. 312' })).status).toBe(400);
    expect((await as('L').post('/consultations/slots', { ...slot, startsAt: inMinutes(-5) })).status).toBe(400);
    // A course the lecturer does not teach.
    expect((await as('L').post('/consultations/slots', { ...slot, courseOfferingId: randomUUID() })).status).toBe(400);
    const res = await as('L').post('/consultations/slots', { ...slot, repeatWeeks: 2, note: 'Підготовка до модульного контролю' });
    expect(res.status).toBe(201);
    expect(await json<Slot[]>(res)).toHaveLength(2);
    expect((await as('L').post('/consultations/slots', { ...slot, startsAt: inMinutes(24 * 60 + 15) })).status).toBe(409);
  });

  it('booking follows the DM rules: shared course, minors, own slot, capacity', async () => {
    // Students find their lecturers (of this semester's courses) as a starting point.
    const hosts = await json<{ userId: string; upcoming: number }[]>(await as('S1').get('/consultations/hosts'));
    expect(hosts.map((h) => h.userId)).toEqual([ids.L]);
    expect(await json<unknown[]>(await as('S3').get('/consultations/hosts'))).toEqual([]);
    const [slot] = await json<Slot[]>(await as('L').post('/consultations/slots', { startsAt: inMinutes(48 * 60), durationMinutes: 20, mode: 'OFFLINE', location: 'ауд. 214, корп. 1', capacity: 2 }));
    const listed = await json<Slot[]>(await as('S1').get(`/users/${ids.L}/consultations`));
    expect(listed.find((s) => s.id === slot!.id)?.bookable).toBe(true);
    // A student without a shared course sees the schedule but cannot book.
    expect((await json<Slot[]>(await as('S3').get(`/users/${ids.L}/consultations`))).find((s) => s.id === slot!.id)?.bookable).toBe(false);
    expect((await as('S3').post(`/consultations/slots/${slot!.id}/bookings`, {})).status).toBe(403);
    // Minor isolation: a lyceum pupil neither sees nor books a university lecturer.
    expect((await as('P').get(`/users/${ids.L}/consultations`)).status).toBe(403);
    expect((await as('P').post(`/consultations/slots/${slot!.id}/bookings`, {})).status).toBe(403);
    expect((await as('L').post(`/consultations/slots/${slot!.id}/bookings`, {})).status).toBe(403);

    expect((await as('S1').post(`/consultations/slots/${slot!.id}/bookings`, { topic: 'Лабораторна робота 3' })).status).toBe(201);
    expect((await as('S1').post(`/consultations/slots/${slot!.id}/bookings`, {})).status).toBe(409);
    expect((await as('S2').post(`/consultations/slots/${slot!.id}/bookings`, {})).status).toBe(201);
    // Full: staff may book a colleague, but there is no seat left.
    expect((await as('H').post(`/consultations/slots/${slot!.id}/bookings`, {})).status).toBe(409);
    // Overbooking at rest: the trigger counts seats even without the API.
    await expect(prisma.$executeRaw`INSERT INTO consultation_bookings (id, slot_id, student_id) VALUES (${randomUUID()}::uuid, ${slot!.id}::uuid, ${ids.H}::uuid)`).rejects.toThrow(/full/);

    // Topics are for the host only.
    const mineL = await json<{ hosting: Slot[] }>(await as('L').get('/consultations/mine'));
    expect(mineL.hosting.find((s) => s.id === slot!.id)?.bookings?.map((b) => b.topic)).toEqual(['Лабораторна робота 3', null]);
    const mineS2 = await json<{ booked: Slot[] }>(await as('S2').get('/consultations/mine'));
    const seen = mineS2.booked.find((s) => s.id === slot!.id)!;
    expect(seen.bookings).toBeNull();
    expect(JSON.stringify(seen)).not.toContain('Лабораторна');

    // A booking is cancelled, never edited or deleted.
    await expect(prisma.$executeRaw`UPDATE consultation_bookings SET topic = 'x' WHERE slot_id = ${slot!.id}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`DELETE FROM consultation_bookings WHERE slot_id = ${slot!.id}::uuid`).rejects.toThrow();
    expect((await as('S2').del(`/consultations/slots/${slot!.id}/booking`)).status).toBe(200);
    expect((await as('S2').del(`/consultations/slots/${slot!.id}/booking`)).status).toBe(404);
    // A published slot never moves.
    await expect(prisma.$executeRaw`UPDATE consultation_slots SET starts_at = starts_at + interval '1 day' WHERE id = ${slot!.id}::uuid`).rejects.toThrow();
  });

  it('a slot for one course accepts only its students', async () => {
    const co = await prisma.courseOffering.findFirstOrThrow({ where: { externalId: `CO7-${sfx}` } });
    expect((await json<{ id: string }[]>(await as('L').get('/consultations/courses'))).map((c) => c.id)).toEqual([co.id]);
    const [slot] = await json<Slot[]>(await as('L').post('/consultations/slots', { startsAt: inMinutes(72 * 60), durationMinutes: 30, mode: 'ONLINE', capacity: 5, courseOfferingId: co.id }));
    expect((await as('H').post(`/consultations/slots/${slot!.id}/bookings`, {})).status).toBe(403);
    expect((await as('S1').post(`/consultations/slots/${slot!.id}/bookings`, {})).status).toBe(201);
  });

  it('online room: open only around the slot, only for the host and booked students', async () => {
    const [later] = await json<Slot[]>(await as('L').post('/consultations/slots', { startsAt: inMinutes(5 * 24 * 60), durationMinutes: 30, mode: 'ONLINE' }));
    expect((await as('S1').post(`/consultations/slots/${later!.id}/bookings`, {})).status).toBe(201);
    expect((await as('S1').post(`/consultations/slots/${later!.id}/join`)).status).toBe(409);

    const [soon] = await json<Slot[]>(await as('L').post('/consultations/slots', { startsAt: inMinutes(5), durationMinutes: 30, mode: 'ONLINE', capacity: 3 }));
    // IDOR: not booked, no entry.
    expect((await as('S2').post(`/consultations/slots/${soon!.id}/join`)).status).toBe(403);
    expect((await as('S1').post(`/consultations/slots/${soon!.id}/bookings`, {})).status).toBe(201);
    const join = await json<Join>(await as('S1').post(`/consultations/slots/${soon!.id}/join`));
    expect(media.grants.at(-1)).toMatchObject({ identity: ids.S1, canPublish: true });
    const host = await json<Join>(await as('L').post(`/consultations/slots/${soon!.id}/join`));
    expect(host.callId).toBe(join.callId);
    expect((await as('S2').post(`/calls/${join.callId}/join`)).status).toBe(403);

    // The student cancels: out of the room at the next re-validation.
    const room = await roomOf(join.callId);
    media.connect(room, ids.L!);
    media.connect(room, ids.S1!);
    expect((await as('S1').del(`/consultations/slots/${soon!.id}/booking`)).status).toBe(200);
    await calls.revalidate();
    expect(await media.participants(room)).toEqual([ids.L]);
    expect((await as('S1').post(`/calls/${join.callId}/join`)).status).toBe(403);

    // The host cancels the slot: the room closes and nobody can book.
    expect((await as('S2').post(`/consultations/slots/${soon!.id}/cancel`)).status).toBe(403);
    expect((await json<Slot>(await as('L').post(`/consultations/slots/${soon!.id}/cancel`))).status).toBe('CANCELLED');
    expect(media.closed).toContain(room);
    expect((await as('S2').post(`/consultations/slots/${soon!.id}/bookings`, {})).status).toBe(409);
    expect((await as('L').post(`/consultations/slots/${soon!.id}/join`)).status).toBe(409);
    await expect(prisma.$executeRaw`UPDATE consultation_slots SET status = 'ACTIVE', cancelled_at = NULL WHERE id = ${soon!.id}::uuid`).rejects.toThrow();
  });
});
