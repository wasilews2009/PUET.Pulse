/**
 * End-to-end tests of Phase 3 against a real PostgreSQL (migrated + seeded):
 * channel auto-provisioning from the sync, messaging with threads, IDOR and DM
 * rules, private groups, self-destruct timers, Quiet Hours, the WebSocket gateway
 * and real vodozemac E2EE between two users through the key directory.
 *
 *   RUN_DB_TESTS=1 DATABASE_URL=... pnpm --filter @puet/api test
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@puet/database';
import { HttpTransport, PulseCrypto } from '@puet/e2ee';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule, REDIS } from '../../src/app.module';
import { OIDC_PROVIDER, type IdTokenClaims, type OidcProvider } from '../../src/auth/oidc.service';
import { APP_CONFIG, loadConfig } from '../../src/config/config';
import { sign } from '../../src/integrations/hmac';
import { DIGEST_STORE, MemoryDigestStore } from '../../src/notifications/digest.store';
import { NotificationService } from '../../src/notifications/notification.service';
import { JobsService } from '../../src/provisioning/jobs.service';
import { ProvisioningService } from '../../src/provisioning/provisioning.service';
import { MemoryRealtimeBus, REALTIME_BUS } from '../../src/realtime/realtime.bus';
import { MemorySessionStore, SESSION_STORE } from '../../src/session/session.store';

const enabled = process.env.RUN_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const WEB = 'https://pulse.test';
const SERVER_NAME = 'pulse.test';
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

interface Msg {
  id: string;
  body: string | null;
  ciphertext: string | null;
  senderId: string;
  createdAt: string;
  expiresAt: string | null;
  deleted: boolean;
  replyCount?: number;
  isPriority: boolean;
}

describe.skipIf(!enabled)('Phase 3 end-to-end (PostgreSQL)', () => {
  let app: INestApplication;
  let base: string;
  const bus = new MemoryRealtimeBus();
  const digests = new MemoryDigestStore();
  const prisma = new PrismaClient();
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let mainId: string;
  let courseId: string;
  let groupChannelId: string;
  let privateGroupId: string;
  const sockets: Socket[] = [];

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
    put: (path: string, body: unknown) => http(path, { method: 'PUT', cookie: cookies[who]!, body: JSON.stringify(body) }),
    patch: (path: string, body: unknown) => http(path, { method: 'PATCH', cookie: cookies[who]!, body: JSON.stringify(body) }),
    del: (path: string) => http(path, { method: 'DELETE', cookie: cookies[who]! }),
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
    return res.json() as Promise<Record<string, unknown>>;
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
    if (!sc) throw new Error(`login failed for ${who}: ${res.status} ${res.headers.get('location')}`);
    cookies[who] = sc.split(';')[0]!;
  }

  function connect(who: string, origin = WEB): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = io(base, {
        path: '/ws',
        transports: ['websocket'],
        extraHeaders: { cookie: cookies[who] ?? '', origin },
        reconnection: false,
        forceNew: true,
      });
      sockets.push(s);
      s.on('connect', () => resolve(s));
      s.on('connect_error', (e) => reject(e));
    });
  }

  const nextEvent = <T>(s: Socket, event: string, ms = 3000) =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
      s.once(event, (p: T) => {
        clearTimeout(t);
        resolve(p);
      });
    });

  const emitAck = <T>(s: Socket, event: string, payload: unknown, ms = 3000) =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no ack for ${event}`)), ms);
      s.once('exception', (e: unknown) => {
        clearTimeout(t);
        reject(Object.assign(new Error('exception'), { payload: e }));
      });
      s.emit(event, payload, (r: T) => {
        clearTimeout(t);
        resolve(r);
      });
    });

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      WEB_ORIGIN: WEB,
      REDIS_URL: 'redis://unused',
      OIDC_ISSUER_URL: 'https://sso.test/realms/puet',
      OIDC_CLIENT_ID: 'pulse',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_REDIRECT_URI: `${WEB}/api/auth/callback`,
      INTEGRATION_CLIENTS: JSON.stringify(clients),
      E2EE_SERVER_NAME: SERVER_NAME,
      JOBS_ENABLED: 'false',
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
      .useValue(digests)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: ['error'] });
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    mainId = (await prisma.tenant.findUniqueOrThrow({ where: { code: 'PUET_MAIN' } })).id;

    // Directory, exactly as the integrations deliver it.
    await webhook('hr', 'hr/staff', {
      records: [
        { hrId: `L-${sfx}`, corporateId: `L-${sfx}`, email: `l-${sfx}@puet.test`, fullNameUk: 'Викладач', position: 'Доцент', primaryDepartmentCode: 'COMPUTER_SCIENCE_IT', roles: [{ role: 'LECTURER' }] },
        { hrId: `CP-${sfx}`, corporateId: `CP-${sfx}`, email: `cp-${sfx}@puet.test`, fullNameUk: 'Цивільний захист', position: 'Інженер ЦЗ', orgUnitCodes: ['CIVIL_PROTECTION'], roles: [{ role: 'CIVIL_PROTECTION_OFFICER' }] },
      ],
    });
    const student = (n: string, group: string, extra: Record<string, unknown> = {}) => ({
      edeboId: `${n}-${sfx}`,
      corporateId: `${n}-${sfx}`,
      email: `${n.toLowerCase()}-${sfx}@puet.test`,
      fullNameUk: `Студент ${n}`,
      birthDate: '2004-05-01',
      educationLevel: 'BACHELOR',
      instituteCode: 'NNI_DAYTIME',
      groupCode: group,
      courseYear: 2,
      ...extra,
    });
    await webhook('edebo', 'edebo/students', {
      records: [student('S1', `KN-${sfx}`, { isGroupLeader: true }), student('S2', `KN-${sfx}`), student('S3', `EK-${sfx}`)],
    });
    await webhook('lyceum', 'edebo/students', {
      records: [{ edeboId: `P-${sfx}`, corporateId: `P-${sfx}`, email: `p-${sfx}@puet.test`, fullNameUk: 'Учень', educationLevel: 'LYCEUM', groupCode: `10A-${sfx}`, courseYear: 10 }],
    });
    const load = await webhook('hr', 'teaching-load', {
      semester: { code: `S3-${sfx}`, startsOn: '2026-09-01', endsOn: '2027-01-31', isCurrent: true },
      offerings: [
        {
          externalId: `CO-${sfx}`,
          departmentCode: 'COMPUTER_SCIENCE_IT',
          discipline: { code: `ALG-${sfx}`, nameUk: 'Алгоритми', nameEn: 'Algorithms' },
          lecturerHrIds: [`L-${sfx}`],
          groupCodes: [`KN-${sfx}`],
        },
      ],
    });
    expect(load.channels).toMatchObject({ channels: expect.any(Number) });

    for (const n of ['S1', 'S2', 'S3']) ids[n] = (await prisma.user.findUniqueOrThrow({ where: { edeboId: `${n}-${sfx}` } })).id;
    ids.P = (await prisma.user.findUniqueOrThrow({ where: { edeboId: `P-${sfx}` } })).id;
    ids.L = (await prisma.user.findUniqueOrThrow({ where: { hrId: `L-${sfx}` } })).id;
    ids.CP = (await prisma.user.findUniqueOrThrow({ where: { hrId: `CP-${sfx}` } })).id;
    const rector = await prisma.user.create({
      data: {
        tenantId: mainId,
        corporateId: `R-${sfx}`,
        email: `r-${sfx}@puet.test`,
        fullNameUk: 'Проректор',
        oidcSubject: `sub-R-${sfx}`,
        kind: 'STAFF',
        roleAssignments: { create: { role: 'RECTORATE', tenantId: mainId, source: 'ADMIN' } },
      },
    });
    ids.R = rector.id;

    for (const n of ['S1', 'S2', 'S3', 'L', 'CP']) await login(n, { sub: `sub-${n}-${sfx}`, email: `${n.toLowerCase()}-${sfx}@puet.test`, amr: ['pwd'] });
    await login('P', { sub: `sub-P-${sfx}`, email: `p-${sfx}@puet.test`, amr: ['pwd'] });
    await login('R', { sub: `sub-R-${sfx}`, email: `r-${sfx}@puet.test`, amr: ['pwd', 'otp'] });
    // The rector was granted in the admin panel, not by a sync: re-run provisioning.
    await app.get(ProvisioningService).reconcileTenant(mainId);
  }, 120_000);

  afterAll(async () => {
    for (const s of sockets) s.close();
    await app?.close();
    await prisma.$disconnect();
  });

  // ── Auto-provisioning ────────────────────────────────────────────

  it('provisions the course channel (threads, auto-archive), the group channel and Civil Protection', async () => {
    const offering = await prisma.courseOffering.findFirstOrThrow({ where: { externalId: `CO-${sfx}` }, include: { channel: { include: { members: true } } } });
    const course = offering.channel!;
    courseId = course.id;
    expect(course).toMatchObject({ type: 'COURSE', threadsRequired: true, e2eeMode: 'DISABLED', nameUk: 'Алгоритми' });
    expect(course.autoArchiveAt?.toISOString()).toBe('2027-02-01T00:00:00.000Z');
    const roles = Object.fromEntries(course.members.map((m) => [m.userId, m.role]));
    expect(roles).toEqual({ [ids.L!]: 'OWNER', [ids.S1!]: 'MEMBER', [ids.S2!]: 'MEMBER' });

    const group = await prisma.channel.findFirstOrThrow({
      where: { type: 'ACADEMIC_GROUP', academicGroup: { code: `KN-${sfx}` } },
      include: { members: true },
    });
    groupChannelId = group.id;
    expect(group.members.find((m) => m.userId === ids.S1)?.role).toBe('MODERATOR'); // group leader

    const emergency = await prisma.channel.findUniqueOrThrow({ where: { provisionKey: `emergency:${mainId}` }, include: { members: { where: { userId: { in: [ids.S1!, ids.CP!] } } } } });
    expect(Object.fromEntries(emergency.members.map((m) => [m.userId, m.role]))).toEqual({ [ids.S1!]: 'READ_ONLY', [ids.CP!]: 'OWNER' });
  });

  it('lists my channels with unread counters', async () => {
    const res = await as('S1').get('/me/channels');
    expect(res.status).toBe(200);
    const list = (await res.json()) as { id: string; type: string; unread: number }[];
    expect(list.map((c) => c.id)).toEqual(expect.arrayContaining([courseId, groupChannelId]));
  });

  // ── Messaging, threads, IDOR ─────────────────────────────────────

  let topicId: string;
  let replyId: string;

  it('threads required: students reply in threads, the lecturer opens topics', async () => {
    expect((await as('S1').post(`/channels/${courseId}/messages`, { body: 'top-level' })).status).toBe(403);
    const topic = await as('L').post(`/channels/${courseId}/messages`, { body: 'Лабораторна робота № 1' });
    expect(topic.status).toBe(201);
    topicId = ((await topic.json()) as Msg).id;
    const reply = await as('S1').post(`/channels/${courseId}/messages`, { body: 'Питання до завдання 2', threadRootId: topicId });
    expect(reply.status).toBe(201);
    replyId = ((await reply.json()) as Msg).id;

    const timeline = (await (await as('S2').get(`/channels/${courseId}/messages`)).json()) as Msg[];
    expect(timeline.find((m) => m.id === topicId)?.replyCount).toBe(1);
    const thread = (await (await as('S2').get(`/channels/${courseId}/messages?threadRootId=${topicId}`)).json()) as Msg[];
    expect(thread.map((m) => m.id)).toEqual([replyId]);

    const unread = ((await (await as('S2').get('/me/channels')).json()) as { id: string; unread: number }[]).find((c) => c.id === courseId);
    expect(unread?.unread).toBe(2);
    expect((await as('S2').post(`/channels/${courseId}/read`)).status).toBe(200);
    const after = ((await (await as('S2').get('/me/channels')).json()) as { id: string; unread: number }[]).find((c) => c.id === courseId);
    expect(after?.unread).toBe(0);
  });

  it('IDOR: a student of another group cannot read, post or list members of the course', async () => {
    expect((await as('S3').get(`/channels/${courseId}/messages`)).status).toBe(403);
    expect((await as('S3').post(`/channels/${courseId}/messages`, { body: 'x', threadRootId: topicId })).status).toBe(403);
    expect((await as('S3').get(`/channels/${courseId}/members`)).status).toBe(403);
    // An unknown id looks exactly like a forbidden one.
    expect((await as('S3').get(`/channels/${randomUUID()}/messages`)).status).toBe(403);
  });

  it('IDOR: only the author edits; author or moderator deletes (tombstone)', async () => {
    expect((await as('S2').patch(`/messages/${replyId}`, { body: 'hijack' })).status).toBe(403);
    expect((await as('S2').del(`/messages/${replyId}`)).status).toBe(403);
    const edited = await as('S1').patch(`/messages/${replyId}`, { body: 'Питання до завдання 3' });
    expect(edited.status).toBe(200);
    expect((await as('L').del(`/messages/${replyId}`)).status).toBe(200);
    const row = await prisma.message.findUniqueOrThrow({ where: { id: replyId } });
    expect(row.body).toBeNull();
    expect(row.deletedAt).not.toBeNull();
  });

  it('E2EE modes: official channels refuse ciphertext; mandatory rooms refuse plaintext', async () => {
    expect(
      (await as('L').post(`/channels/${courseId}/messages`, { ciphertext: 'AAAA', scheme: 'MEGOLM', senderDeviceId: randomUUID() })).status,
    ).toBe(400);
    const rectorate = await prisma.channel.findFirstOrThrow({ where: { tenantId: mainId, orgUnit: { code: 'RECTORATE' }, type: 'GOVERNANCE' } });
    expect(rectorate.e2eeMode).toBe('MANDATORY');
    expect((await as('R').post(`/channels/${rectorate.id}/messages`, { body: 'plaintext' })).status).toBe(400);
    // And the database refuses it even if the API were bypassed.
    await expect(prisma.message.create({ data: { channelId: rectorate.id, senderId: ids.R!, body: 'bypass' } })).rejects.toThrow();
  });

  // ── Direct messages and private groups ───────────────────────────

  it('DM rules: shared course allows; no shared course, Rectorate and minors are refused', async () => {
    const first = await as('S1').post(`/users/${ids.L}/direct`);
    expect(first.status).toBe(201);
    const again = (await (await as('S1').post(`/users/${ids.L}/direct`)).json()) as { channelId: string; created: boolean };
    expect(again.created).toBe(false);
    expect((await as('S3').post(`/users/${ids.L}/direct`)).status).toBe(403);
    expect((await as('S1').post(`/users/${ids.R}/direct`)).status).toBe(403);
    expect((await as('S1').post(`/users/${ids.P}/direct`)).status).toBe(403);
  });

  it('minor isolation: a lyceum pupil cannot be pulled into a private group', async () => {
    expect((await as('S1').post('/channels', { nameUk: 'Проєкт', memberIds: [ids.S2, ids.P] })).status).toBe(403);
    const ok = await as('S1').post('/channels', { nameUk: 'Проєкт', memberIds: [ids.S2] });
    expect(ok.status).toBe(201);
    privateGroupId = ((await ok.json()) as { channelId: string }).channelId;
    expect((await as('S1').post(`/channels/${privateGroupId}/members`, { userIds: [ids.P] })).status).toBe(403);
    expect((await as('S2').post(`/channels/${privateGroupId}/members`, { userIds: [ids.S3] })).status).toBe(403); // not a moderator
  });

  it('self-destruct timer: messages expire and are purged for good', async () => {
    const dm = await prisma.channel.create({
      data: {
        tenantId: mainId,
        type: 'PRIVATE_GROUP',
        e2eeMode: 'OPTIONAL',
        nameUk: 'TTL',
        members: { create: [{ userId: ids.S1!, role: 'OWNER' }, { userId: ids.S2!, role: 'MEMBER' }] },
      },
    });
    expect((await as('S1').patch(`/channels/${dm.id}`, { messageTtlSeconds: 3600 })).status).toBe(200);
    expect((await as('S1').patch(`/channels/${courseId}`, { messageTtlSeconds: 3600 })).status).toBe(403);
    const m = (await (await as('S1').post(`/channels/${dm.id}/messages`, { body: 'зникне' })).json()) as Msg;
    expect(new Date(m.expiresAt!).getTime() - Date.now()).toBeGreaterThan(3500_000);
    const purged = await app.get(JobsService).purgeExpiredMessages(new Date(Date.now() + 2 * 3600_000));
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await prisma.message.findUnique({ where: { id: m.id } })).toBeNull();
  });

  // ── Quiet Hours and Civil Protection ─────────────────────────────

  it('Quiet Hours hold student messages for the lecturer; Civil Protection alerts bypass them', async () => {
    const qh = await as('L').put('/me/quiet-hours', {
      enabled: true,
      timezone: 'Europe/Kyiv',
      startMinute: 0,
      endMinute: 1439,
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      digestEnabled: true,
    });
    expect(qh.status).toBe(200);
    expect((await as('S1').put('/me/quiet-hours', { enabled: true, timezone: 'Europe/Kyiv', startMinute: 0, endMinute: 1, weekdays: [], digestEnabled: true })).status).toBe(403);

    // At 23:59 Kyiv the window [00:00, 23:59) is over; skip that minute.
    const kyivMinute = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).replace(':', '')) % 100;
    if (kyivMinute === 59) return;

    bus.sent.length = 0;
    await as('S2').post(`/channels/${courseId}/messages`, { body: 'Питання ввечері', threadRootId: topicId });
    const notified = bus.sent.filter((e) => e.kind === 'emit' && e.event === 'notification').flatMap((e) => e.userIds);
    expect(notified).not.toContain(ids.L);
    const released = await app.get(NotificationService).releaseDueDigests(new Date(Date.now() + 86_400_000));
    expect(released).toBeGreaterThanOrEqual(1);
    expect(bus.sent.some((e) => e.kind === 'emit' && e.event === 'notification.digest' && e.userIds.includes(ids.L!))).toBe(true);

    bus.sent.length = 0;
    const emergency = await prisma.channel.findUniqueOrThrow({ where: { provisionKey: `emergency:${mainId}` } });
    expect((await as('S1').post(`/channels/${emergency.id}/messages`, { body: 'fake alert' })).status).toBe(403);
    const alert = await as('CP').post(`/channels/${emergency.id}/messages`, { body: 'Повітряна тривога' });
    expect(alert.status).toBe(201);
    expect(((await alert.json()) as Msg).isPriority).toBe(true);
    const priority = bus.sent.find((e) => e.kind === 'emit' && e.event === 'notification' && e.userIds.includes(ids.L!));
    expect(priority).toBeDefined();
  });

  // ── WebSocket gateway ────────────────────────────────────────────

  it('CSWSH: a socket from another origin or without a session is refused', async () => {
    await expect(connect('S1', 'https://evil.test')).rejects.toThrow(/Access denied/);
    await expect(connect('nobody')).rejects.toThrow(/Unauthorized/);
  });

  it('delivers messages to current members only and authorizes every event', async () => {
    const s1 = await connect('S1');
    const s2 = await connect('S2');
    const s3 = await connect('S3');
    const got = nextEvent<Msg>(s2, 'message.new');
    let s3Got = false;
    s3.on('message.new', () => (s3Got = true));

    const ack = await emitAck<Msg>(s1, 'message.send', { channelId: groupChannelId, body: 'Привіт, групо' });
    expect(ack.body).toBe('Привіт, групо');
    expect((await got).id).toBe(ack.id);

    await expect(emitAck(s3, 'message.send', { channelId: groupChannelId, body: 'intrusion' })).rejects.toThrow();
    await expect(emitAck(s3, 'channel.read', { channelId: 'not-a-uuid' })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    expect(s3Got).toBe(false);
  });

  // ── E2EE with vodozemac through the real key directory ───────────

  it('E2EE: two users exchange a Megolm-encrypted message; the server never sees plaintext', async () => {
    const device = async (who: string) => {
      const res = await as(who).post('/e2ee/devices', { label: `${who} laptop` });
      expect(res.status).toBe(201);
      const { deviceId } = (await res.json()) as { deviceId: string };
      const transport = new HttpTransport(base, deviceId, fetch as never, () => ({ cookie: cookies[who]!, origin: WEB }));
      return { deviceId, crypto: await PulseCrypto.create({ userId: ids[who]!, serverName: SERVER_NAME, deviceId, transport }) };
    };
    const s1 = await device('S1');
    const s2 = await device('S2');

    const members = ((await (await as('S1').get(`/channels/${privateGroupId}/members`)).json()) as { userId: string }[]).map((m) => m.userId);
    expect(members.sort()).toEqual([ids.S1, ids.S2].sort());
    const enc = await s1.crypto.encrypt(privateGroupId, members, { msgtype: 'm.text', body: 'Зашифрований текст' });
    const sent = await as('S1').post(`/channels/${privateGroupId}/messages`, { ...enc, senderDeviceId: s1.deviceId });
    expect(sent.status).toBe(201);
    const msg = (await sent.json()) as Msg;

    const stored = await prisma.message.findUniqueOrThrow({ where: { id: msg.id } });
    expect(stored.body).toBeNull();
    expect(stored.scheme).toBe('MEGOLM');
    expect(Buffer.from(stored.ciphertext!).toString('utf8')).not.toContain('Зашифрований');

    await s2.crypto.sync();
    const [fetched] = (await (await as('S2').get(`/channels/${privateGroupId}/messages?limit=1`)).json()) as Msg[];
    const plain = await s2.crypto.decrypt({ id: fetched!.id, channelId: privateGroupId, senderId: fetched!.senderId, createdAt: fetched!.createdAt, ciphertext: fetched!.ciphertext! });
    expect(plain.content.body).toBe('Зашифрований текст');
    expect(plain.senderDeviceId).toBe(s1.deviceId);
    s1.crypto.close();
    s2.crypto.close();
  });

  it('key directory zero trust: strangers get no keys, cannot claim, cannot inject envelopes or overwrite devices', async () => {
    const s1Device = await prisma.device.findFirstOrThrow({ where: { userId: ids.S1, revokedAt: null } });
    const mxS1 = `@${ids.S1}:${SERVER_NAME}`;

    const q = (await (await as('S3').post('/e2ee/keys/query', { device_keys: { [mxS1]: [] } })).json()) as { device_keys: Record<string, unknown> };
    expect(q.device_keys).toEqual({});
    const c = (await (await as('S3').post('/e2ee/keys/claim', { one_time_keys: { [mxS1]: { [s1Device.id]: 'signed_curve25519' } } })).json()) as {
      one_time_keys: Record<string, unknown>;
    };
    expect(c.one_time_keys).toEqual({});

    const s3Device = (await (await as('S3').post('/e2ee/devices', { label: 'S3' })).json()) as { deviceId: string };
    const before = await prisma.toDeviceMessage.count({ where: { recipientDeviceId: s1Device.id } });
    const inject = await as('S3').put(`/e2ee/devices/${s3Device.deviceId}/sendToDevice/m.room.encrypted/t1`, {
      messages: { [mxS1]: { '*': { forged: true } } },
    });
    expect(inject.status).toBe(200);
    expect(await prisma.toDeviceMessage.count({ where: { recipientDeviceId: s1Device.id } })).toBe(before);

    // IDOR: uploading keys to, or reading the inbox of, someone else's device.
    expect((await as('S3').post(`/e2ee/devices/${s1Device.id}/keys/upload`, { one_time_keys: {} })).status).toBe(403);
    expect((await as('S3').get(`/e2ee/devices/${s1Device.id}/sync`)).status).toBe(403);
    // Device keys must describe the caller's own user and device.
    const spoof = await as('S3').post(`/e2ee/devices/${s3Device.deviceId}/keys/upload`, {
      device_keys: {
        user_id: mxS1,
        device_id: s3Device.deviceId,
        algorithms: ['m.olm.v1.curve25519-aes-sha2'],
        keys: { [`ed25519:${s3Device.deviceId}`]: 'A'.repeat(43), [`curve25519:${s3Device.deviceId}`]: 'B'.repeat(43) },
        signatures: {},
      },
    });
    expect(spoof.status).toBe(400);
  });

  // ── Offboarding ──────────────────────────────────────────────────

  it('offboarding drops the live socket, revokes E2EE devices and removes auto memberships', async () => {
    const s2 = await connect('S2');
    const closed = nextEvent<string>(s2, 'disconnect');
    await webhook('hr', 'offboarding', { records: [{ edeboId: `S2-${sfx}`, reason: 'EXPELLED' }] });
    expect(await closed).toBeTruthy();
    expect(await prisma.device.count({ where: { userId: ids.S2, revokedAt: null } })).toBe(0);
    expect(await prisma.channelMember.count({ where: { userId: ids.S2, source: 'AUTO' } })).toBe(0);
    // Manual memberships (private chats) and messages stay for the archive.
    expect(await prisma.message.count({ where: { senderId: ids.S2 } })).toBeGreaterThan(0);
  });
});
