/**
 * Phase 6 tests against a real PostgreSQL: formal votes of collegial bodies (secret and
 * open, quorum, protocol), polls in channels and directives with acknowledgement. Named
 * after the attacks they stop: IDOR, double voting, late joiners, vote tampering at rest,
 * secret-ballot linkage.
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

interface Poll {
  id: string;
  messageId: string;
  status: string;
  participants: number;
  eligibleCount: number;
  quorum: number | null;
  counts: number[] | null;
  voters: string[][] | null;
  me: { voted: boolean; eligible: boolean; options: number[] | null };
  quorumReached: boolean | null;
  adopted: boolean | null;
}

describe.skipIf(!enabled)('Phase 6 polls, votes and directives (PostgreSQL)', () => {
  let app: INestApplication;
  let base: string;
  let ca: CaMaterial;
  const store = new MemoryObjectStore();
  const prisma = new PrismaClient();
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let courseChannelId: string;
  let councilId: string;
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
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: ['error'] });
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    await webhook('hr', 'hr/staff', {
      records: [
        {
          hrId: `L6-${sfx}`,
          corporateId: `L6-${sfx}`,
          email: `l-${sfx}@puet.test`,
          fullNameUk: `Викладачка П'ята ${sfx}`,
          phone: '+380501234567',
          position: 'Доцент',
          primaryDepartmentCode: 'COMPUTER_SCIENCE_IT',
          roles: [{ role: 'LECTURER' }],
        },
        { hrId: `H6-${sfx}`, corporateId: `H6-${sfx}`, email: `h-${sfx}@puet.test`, fullNameUk: `Завідувач П'ятий ${sfx}`, position: 'Завідувач кафедри', primaryDepartmentCode: 'LAW', roles: [{ role: 'DEPARTMENT_HEAD', departmentCode: 'LAW' }] },
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
    await webhook('edebo', 'edebo/students', { records: [student('S1', `KN5-${sfx}`), student('S2', `KN5-${sfx}`), student('S3', `EK5-${sfx}`)] });
    await webhook('lyceum', 'edebo/students', {
      records: [{ edeboId: `P-${sfx}`, corporateId: `P-${sfx}`, email: `p-${sfx}@puet.test`, fullNameUk: `Учень Ліцею ${sfx}`, educationLevel: 'LYCEUM', groupCode: `10B-${sfx}`, courseYear: 10 }],
    });
    await webhook('hr', 'teaching-load', {
      semester: { code: `S5-${sfx}`, startsOn: '2026-09-01', endsOn: '2027-01-31', isCurrent: true },
      offerings: [
        {
          externalId: `CO5-${sfx}`,
          departmentCode: 'COMPUTER_SCIENCE_IT',
          discipline: { code: `SEC-${sfx}`, nameUk: 'Кібербезпека', nameEn: 'Cybersecurity' },
          lecturerHrIds: [`L6-${sfx}`],
          groupCodes: [`KN5-${sfx}`],
        },
      ],
    });
    for (const n of ['S1', 'S2', 'S3', 'P']) ids[n] = (await prisma.user.findUniqueOrThrow({ where: { edeboId: `${n}-${sfx}` } })).id;
    ids.L = (await prisma.user.findUniqueOrThrow({ where: { hrId: `L6-${sfx}` } })).id;
    ids.H = (await prisma.user.findUniqueOrThrow({ where: { hrId: `H6-${sfx}` } })).id;
    courseChannelId = (await prisma.courseOffering.findFirstOrThrow({ where: { externalId: `CO5-${sfx}` }, include: { channel: true } })).channel!.id;
    const tenantId = (await prisma.user.findUniqueOrThrow({ where: { id: ids.L } })).tenantId;
    // A collegial body: the Academic Secretary (L) owns it; S3 sits in as an observer (read-only).
    councilId = (
      await prisma.channel.create({
        data: {
          tenantId,
          type: 'GOVERNANCE',
          e2eeMode: 'DISABLED',
          confidential: true,
          isOfficial: true,
          nameUk: `Вчена рада ${sfx}`,
          members: {
            create: [
              { userId: ids.L!, role: 'OWNER' },
              { userId: ids.H!, role: 'MEMBER' },
              { userId: ids.S1!, role: 'MEMBER' },
              { userId: ids.S3!, role: 'READ_ONLY' },
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


  const vote = (who: string, pollId: string, options: number[]) => as(who).post(`/polls/${pollId}/votes`, { options });
  const poll = async (who: string, pollId: string) => (await (await as(who).get(`/polls/${pollId}`)).json()) as Poll;

  // ── Formal votes of a collegial body ───────────────────────────

  it('only the moderator of a collegial body opens a formal vote, and only where one belongs', async () => {
    expect((await as('H').post(`/channels/${councilId}/polls`, { question: 'Q', mode: 'SECRET', formal: true })).status).toBe(403);
    // Formal votes are for collegial bodies; polls are refused where the server cannot read the room.
    expect((await as('L').post(`/channels/${courseChannelId}/polls`, { question: 'Q', mode: 'SECRET', formal: true })).status).toBe(400);
    const dm = (await (await as('L').post(`/users/${ids.S1}/direct`)).json()) as { channelId: string };
    expect((await as('L').post(`/channels/${dm.channelId}/polls`, { question: 'Q', mode: 'OPEN', options: ['a', 'b'] })).status).toBe(400);
    // IDOR: an outsider cannot open a poll in the council by id.
    expect((await as('S2').post(`/channels/${councilId}/polls`, { question: 'Q', mode: 'OPEN', options: ['a', 'b'] })).status).toBe(403);
    expect((await as('L').post(`/channels/${councilId}/polls`, { question: 'Q', mode: 'SECRET', formal: true, quorum: 9 })).status).toBe(400);
  });

  it('secret ballot: one vote each, nothing revealed before closing, no voter linked to a choice', async () => {
    const res = await as('L').post(`/channels/${councilId}/polls`, { question: `Про затвердження плану ${sfx}`, mode: 'SECRET', formal: true });
    expect(res.status).toBe(201);
    const p = (await res.json()) as Poll;
    // L, H, S1 may vote; the read-only observer is not on the list.
    expect(p.eligibleCount).toBe(3);
    expect(p.quorum).toBe(2);

    expect((await vote('H', p.id, [0])).status).toBe(201);
    // Double voting is refused, by the API and by the primary key.
    expect((await vote('H', p.id, [1])).status).toBe(409);
    expect((await vote('S3', p.id, [0])).status).toBe(403);
    // IDOR: a non-member can neither read nor vote.
    expect((await as('S2').get(`/polls/${p.id}`)).status).toBe(403);
    expect((await vote('S2', p.id, [0])).status).toBe(403);
    // Late joiner: added after the vote opened, not on the frozen list of voters.
    await prisma.channelMember.create({ data: { channelId: councilId, userId: ids.S2!, role: 'MEMBER' } });
    expect((await vote('S2', p.id, [0])).status).toBe(403);
    await prisma.channelMember.delete({ where: { channelId_userId: { channelId: councilId, userId: ids.S2! } } });
    // Out-of-range and multiple answers.
    expect((await vote('S1', p.id, [5])).status).toBe(400);
    expect((await vote('S1', p.id, [0, 1])).status).toBe(400);
    expect((await vote('S1', p.id, [1])).status).toBe(201);

    const open = await poll('H', p.id);
    expect(open.participants).toBe(2);
    expect(open.counts).toBeNull();
    expect(open.voters).toBeNull();
    expect(open.me).toEqual({ voted: true, eligible: true, options: null });

    // Secret-ballot linkage: no attributed ballot exists, only anonymous counters.
    expect(await prisma.pollBallot.count({ where: { pollId: p.id } })).toBe(0);
    const tallies = await prisma.pollTally.findMany({ where: { pollId: p.id }, orderBy: { optionIndex: 'asc' } });
    expect(tallies.map((t) => t.votes)).toEqual([1, 1, 0]);
    await expect(prisma.$executeRaw`INSERT INTO poll_ballots (poll_id, user_id, option_indexes) VALUES (${p.id}::uuid, ${ids.L}::uuid, ARRAY[0])`).rejects.toThrow();
    // Tampering: a counter can only grow by one through a vote.
    await expect(prisma.$executeRaw`UPDATE poll_tallies SET votes = 10 WHERE poll_id = ${p.id}::uuid AND option_index = 0`).rejects.toThrow();
    await expect(prisma.$executeRaw`DELETE FROM poll_participations WHERE poll_id = ${p.id}::uuid`).rejects.toThrow();
    // The audit trail records participation, never the choice.
    const audit = await prisma.auditLog.findMany({ where: { action: 'poll.vote', resourceId: p.id } });
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit.map((a) => a.metadata))).not.toMatch(/option|choice|FOR|AGAINST/);

    // Only the author or a moderator closes.
    expect((await as('H').post(`/polls/${p.id}/close`)).status).toBe(403);
    const closed = (await (await as('L').post(`/polls/${p.id}/close`)).json()) as Poll;
    expect(closed.status).toBe('CLOSED');
    expect(closed.counts).toEqual([1, 1, 0]);
    expect(closed.quorumReached).toBe(true);
    expect(closed.adopted).toBe(false);
    expect((await vote('L', p.id, [0])).status).toBe(409);
    expect((await as('L').post(`/polls/${p.id}/close`)).status).toBe(409);

    // Tampering at rest: a closed vote cannot be reopened or rewritten, and no late vote slips in.
    await expect(prisma.$executeRaw`UPDATE polls SET status = 'OPEN' WHERE id = ${p.id}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE polls SET result = '{"counts":[3,0,0],"participants":3}' WHERE id = ${p.id}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`INSERT INTO poll_participations (poll_id, user_id) VALUES (${p.id}::uuid, ${ids.L}::uuid)`).rejects.toThrow();

    const pdf = await as('S1').get(`/polls/${p.id}/protocol.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await as('S2').get(`/polls/${p.id}/protocol.pdf`)).status).toBe(403);
  });

  it('open (roll-call) vote: names are recorded, the quorum decides, the protocol needs a closed vote', async () => {
    const p = (await (await as('L').post(`/channels/${councilId}/polls`, { question: `Поіменне ${sfx}`, mode: 'OPEN', formal: true, quorum: 3 })).json()) as Poll;
    expect((await as('L').get(`/polls/${p.id}/protocol.pdf`)).status).toBe(409);
    expect((await vote('L', p.id, [0])).status).toBe(201);
    expect((await vote('H', p.id, [0])).status).toBe(201);
    const open = await poll('S1', p.id);
    expect(open.counts).toEqual([2, 0, 0]);
    expect(open.voters![0]!.sort()).toEqual([ids.L, ids.H].sort());
    expect(open.me.voted).toBe(false);
    // A ballot cannot be rewritten after the fact.
    await expect(prisma.$executeRaw`UPDATE poll_ballots SET option_indexes = ARRAY[1] WHERE poll_id = ${p.id}::uuid`).rejects.toThrow();
    const closed = (await (await as('L').post(`/polls/${p.id}/close`)).json()) as Poll;
    // Two of three: unanimous, but below the quorum of three.
    expect(closed.quorumReached).toBe(false);
    expect(closed.adopted).toBe(false);
    expect((await as('L').get(`/polls/${p.id}/protocol.pdf?lang=en`)).status).toBe(200);
  });

  // ── Polls in channels ───────────────────────────

  it('course polls: lecturers open them, students vote; deadlines close them', async () => {
    // Course channels require threads: students do not post top-level, polls included.
    expect((await as('S1').post(`/channels/${courseChannelId}/polls`, { question: 'Q', mode: 'OPEN', options: ['a', 'b'] })).status).toBe(403);
    const res = await as('L').post(`/channels/${courseChannelId}/polls`, {
      question: 'Коли перескладання?',
      mode: 'OPEN',
      options: ['Понеділок', 'Середа', 'П’ятниця'],
      multipleChoice: true,
    });
    expect(res.status).toBe(201);
    const p = (await res.json()) as Poll;
    expect((await vote('S1', p.id, [0, 2])).status).toBe(201);
    const view = await poll('S2', p.id);
    expect(view.counts).toEqual([1, 0, 1]);
    expect(view.voters![2]).toEqual([ids.S1]);
    // The poll shows up in the timeline as a message.
    const history = (await (await as('S2').get(`/channels/${courseChannelId}/messages`)).json()) as { id: string; pollId: string | null }[];
    expect(history.find((m) => m.id === p.messageId)?.pollId).toBe(p.id);
    // IDOR: S3 is not in the course.
    expect((await vote('S3', p.id, [0])).status).toBe(403);
    // Deadline passed: the next vote is refused and the poll closes itself.
    await prisma.poll.update({ where: { id: p.id }, data: { closesAt: new Date(Date.now() - 1000) } });
    expect((await vote('S2', p.id, [1])).status).toBe(409);
    expect((await poll('S2', p.id)).status).toBe('CLOSED');
    expect((await as('L').post(`/channels/${courseChannelId}/polls`, { question: 'Q', mode: 'OPEN', options: ['a', 'A'] })).status).toBe(400);
    expect(bus.sent.some((e) => e.kind === 'emit' && e.event === 'poll.updated')).toBe(true);
  });

  it('deleting the poll message hides the poll from everybody', async () => {
    const p = (await (await as('L').post(`/channels/${courseChannelId}/polls`, { question: 'Тимчасове', mode: 'SECRET', options: ['так', 'ні'] })).json()) as Poll;
    expect((await as('L').del(`/messages/${p.messageId}`)).status).toBe(200);
    expect((await as('S1').get(`/polls/${p.id}`)).status).toBe(403);
    expect((await vote('S1', p.id, [0])).status).toBe(403);
  });

  // ── Directives with acknowledgement ───────────────────────────

  it('directives: moderators issue them, members confirm once, only the author sees who did', async () => {
    expect((await as('S1').post(`/channels/${courseChannelId}/messages`, { body: 'Наказ', requiresAck: true })).status).toBe(403);
    const res = await as('L').post(`/channels/${courseChannelId}/messages`, { body: `Розпорядження ${sfx}`, requiresAck: true });
    expect(res.status).toBe(201);
    const msg = (await res.json()) as { id: string; requiresAck: boolean };
    expect(msg.requiresAck).toBe(true);

    const first = (await (await as('S1').post(`/messages/${msg.id}/ack`)).json()) as { acknowledgedAt: string };
    const again = (await (await as('S1').post(`/messages/${msg.id}/ack`)).json()) as { acknowledgedAt: string };
    expect(again.acknowledgedAt).toBe(first.acknowledgedAt);
    // IDOR: an outsider cannot confirm or read the list.
    expect((await as('S3').post(`/messages/${msg.id}/ack`)).status).toBe(403);
    expect((await as('S3').get(`/messages/${msg.id}/acks`)).status).toBe(403);
    // Members do not see who else confirmed.
    expect((await as('S2').get(`/messages/${msg.id}/acks`)).status).toBe(403);

    const stats = (await (await as('L').get(`/messages/${msg.id}/acks`)).json()) as { total: number; acknowledged: { userId: string }[]; pending: string[] };
    expect(stats.acknowledged.map((a) => a.userId)).toEqual([ids.S1]);
    expect(stats.pending).toContain(ids.S2);
    expect(stats.pending).not.toContain(ids.L);
    expect(stats.total).toBe(stats.acknowledged.length + stats.pending.length);

    const history = (await (await as('S1').get(`/channels/${courseChannelId}/messages`)).json()) as { id: string; acknowledgedAt?: string | null }[];
    expect(history.find((m) => m.id === msg.id)?.acknowledgedAt).toBe(first.acknowledgedAt);

    // An ordinary message cannot be "acknowledged", and confirmations are append-only.
    const plain = (await (await as('L').post(`/channels/${courseChannelId}/messages`, { body: 'Звичайне' })).json()) as { id: string };
    expect((await as('S1').post(`/messages/${plain.id}/ack`)).status).toBe(400);
    await expect(prisma.$executeRaw`DELETE FROM message_acks WHERE message_id = ${msg.id}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`INSERT INTO message_acks (message_id, user_id) VALUES (${plain.id}::uuid, ${ids.S2}::uuid)`).rejects.toThrow();
  });
});
