/**
 * Phase 8 tests against a real PostgreSQL: the corporate bots. Named after the attacks they stop:
 * IDOR on certificate requests and tickets, forged or misdirected webhooks, phishing links in
 * schedule changes, dormitory room leaks, tsquery injection, cross-tenant knowledge, flooding the
 * consultant, and tampering at rest.
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
import { MemoryRateLimiter, RATE_LIMITER } from '../../src/bots/admissions/rate-limiter';
import { BotInboxService } from '../../src/bots/bot-inbox.service';
import { OUTBOX_SENDER, OutboxService, type OutboxSender } from '../../src/bots/outbox.service';
import { APP_CONFIG, loadConfig } from '../../src/config/config';
import { FilesService } from '../../src/files/files.service';
import { FakeScanner, MALWARE_SCANNER } from '../../src/files/malware-scanner';
import { MemoryObjectStore, OBJECT_STORE } from '../../src/files/object-store';
import { sign, verifySignature } from '../../src/integrations/hmac';
import { DIGEST_STORE, MemoryDigestStore } from '../../src/notifications/digest.store';
import { CA_LOADER } from '../../src/pki/pki.service';
import { createRootCa, loadCa, type CaMaterial } from '../../src/pki/x509';
import { MemoryRealtimeBus, REALTIME_BUS } from '../../src/realtime/realtime.bus';
import { MemorySessionStore, SESSION_STORE } from '../../src/session/session.store';
import { plainPdf } from '../fixtures/pdfs';

const enabled = process.env.RUN_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const WEB = 'https://pulse.test';
const sfx = randomUUID().slice(0, 8).toUpperCase();
const DEANERY_SECRET = 'd'.repeat(40);

const clients = {
  hr: { id: randomUUID(), secret: 'h'.repeat(40), tenantCode: 'PUET_MAIN', kinds: ['HR_STAFF', 'TEACHING_LOAD'] },
  edebo: { id: randomUUID(), secret: 'e'.repeat(40), tenantCode: 'PUET_MAIN', kinds: ['EDEBO_STUDENTS'] },
  lyceum: { id: randomUUID(), secret: 'l'.repeat(40), tenantCode: 'PUET_LYCEUM', kinds: ['EDEBO_STUDENTS'] },
  deanery: { id: randomUUID(), secret: 'n'.repeat(40), tenantCode: 'PUET_MAIN', kinds: ['DEANERY'] },
  schedule: { id: randomUUID(), secret: 's'.repeat(40), tenantCode: 'PUET_MAIN', kinds: ['SCHEDULE'] },
  edo: { id: randomUUID(), secret: 'o'.repeat(40), tenantCode: 'PUET_MAIN', kinds: ['EDO'] },
};

let nextClaims: IdTokenClaims = { sub: 'nobody' };
const fakeOidc: OidcProvider = {
  authorizationUrl: async (p) => `https://sso.test/auth?state=${p.state}${p.acr ? `&acr_values=${p.acr}` : ''}`,
  exchange: async () => nextClaims,
  endSessionUrl: async () => undefined,
};

type Sent = { url: string; headers: Record<string, string>; body: string };
const outbound: Sent[] = [];
let senderStatus = 200;
const sender: OutboxSender = async (url, init) => {
  outbound.push({ url, headers: init.headers, body: init.body });
  return { status: senderStatus };
};

type BotMsg = { id: string; direction: string; body: string | null; card: Record<string, unknown> | null };

describe.skipIf(!enabled)('Phase 8 corporate bots (PostgreSQL)', () => {
  let app: INestApplication;
  let base: string;
  let ca: CaMaterial;
  const prisma = new PrismaClient();
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let courseChannelId: string;
  const semester = `S8-${sfx}`;

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
    upload: (channelId: string, bytes: Buffer, name: string) =>
      http(`/channels/${channelId}/files`, {
        method: 'POST',
        cookie: cookies[who]!,
        body: bytes,
        headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) },
      }),
  });
  const json = async <T>(res: Response) => (await res.json()) as T;

  async function webhook(client: keyof typeof clients, path: string, payload: unknown, secret = clients[client].secret) {
    const body = JSON.stringify(payload);
    const t = Math.floor(Date.now() / 1000);
    return fetch(`${base}/integrations/${path}`, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-puet-client': client,
        'x-puet-signature': sign(secret, t, body),
        'idempotency-key': randomUUID(),
      },
    });
  }
  async function ok<T = { created: number; updated: number; errors: { index: number; error: string }[] }>(res: Promise<Response>) {
    const r = await res;
    expect(r.status).toBe(200);
    return json<T>(r);
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

  const messages = async (who: string, bot: string) => json<BotMsg[]>(await as(who).get(`/bots/${bot}/messages`));
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

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
      OUTBOX_DEANERY_URL: 'https://deanery.test/pulse',
      OUTBOX_DEANERY_SECRET: DEANERY_SECRET,
      OUTBOX_EDO_URL: 'https://edo.test/pulse',
      OUTBOX_EDO_SECRET: 'q'.repeat(40),
      ADMISSIONS_RATE_PER_HOUR: '3',
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
      .useValue(new MemoryRealtimeBus())
      .overrideProvider(DIGEST_STORE)
      .useValue(new MemoryDigestStore())
      .overrideProvider(OBJECT_STORE)
      .useValue(new MemoryObjectStore())
      .overrideProvider(MALWARE_SCANNER)
      .useValue(new FakeScanner())
      .overrideProvider(CA_LOADER)
      .useValue(async () => ca)
      .overrideProvider(OUTBOX_SENDER)
      .useValue(sender)
      .overrideProvider(RATE_LIMITER)
      .useValue(new MemoryRateLimiter())
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: ['error'] });
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const staff = (n: string, extra: Record<string, unknown>) => ({
      hrId: `${n}8-${sfx}`,
      corporateId: `${n}8-${sfx}`,
      email: `${n.toLowerCase()}8-${sfx}@puet.test`,
      fullNameUk: `Працівник ${n} ${sfx}`,
      position: 'Фахівець',
      ...extra,
    });
    expect(
      (
        await ok(
          webhook('hr', 'hr/staff', {
            records: [
              staff('L', { primaryDepartmentCode: 'COMPUTER_SCIENCE_IT', roles: [{ role: 'LECTURER' }] }),
              staff('H', { primaryDepartmentCode: 'LAW', roles: [{ role: 'DEPARTMENT_HEAD', departmentCode: 'LAW' }] }),
              staff('IT', { orgUnitCodes: ['IT_CENTER'], roles: [{ role: 'ADMIN_STAFF', orgUnitCode: 'IT_CENTER' }] }),
              staff('AHR', { orgUnitCodes: ['AHR_BUILDINGS'], roles: [{ role: 'FACILITIES_STAFF', orgUnitCode: 'AHR_BUILDINGS' }] }),
              staff('CMD', { roles: [{ role: 'DORM_COMMANDANT', dormitoryNumber: 1 }] }),
              staff('ADM', { orgUnitCodes: ['ADMISSIONS'], roles: [{ role: 'ADMIN_STAFF', orgUnitCode: 'ADMISSIONS' }] }),
              staff('CH', { orgUnitCodes: ['CHANCELLERY'], roles: [{ role: 'ADMIN_STAFF', orgUnitCode: 'CHANCELLERY' }] }),
            ],
          }),
        )
      ).errors,
    ).toEqual([]);
    const student = (n: string, group: string, extra: Record<string, unknown> = {}) => ({
      edeboId: `${n}-${sfx}`,
      corporateId: `${n}-${sfx}`,
      email: `${n.toLowerCase()}-${sfx}@puet.test`,
      fullNameUk: `Студент ${n} ${sfx}`,
      birthDate: '2004-05-01',
      educationLevel: 'BACHELOR',
      instituteCode: 'NNI_DAYTIME',
      groupCode: group,
      courseYear: 2,
      ...extra,
    });
    await ok(
      webhook('edebo', 'edebo/students', {
        records: [
          student('S1', `KN8-${sfx}`, { dormitory: { number: 1, room: `R8-${sfx}`, floor: 2 } }),
          student('S2', `KN8-${sfx}`),
          student('S3', `EK8-${sfx}`),
        ],
      }),
    );
    await ok(
      webhook('lyceum', 'edebo/students', {
        records: [{ edeboId: `P8-${sfx}`, corporateId: `P8-${sfx}`, email: `p8-${sfx}@puet.test`, fullNameUk: `Учень ${sfx}`, educationLevel: 'LYCEUM', groupCode: `10D-${sfx}`, courseYear: 10 }],
      }),
    );
    await ok(
      webhook('hr', 'teaching-load', {
        semester: { code: semester, startsOn: '2026-09-01', endsOn: '2027-01-31', isCurrent: true },
        offerings: [
          {
            externalId: `CO8-${sfx}`,
            departmentCode: 'COMPUTER_SCIENCE_IT',
            discipline: { code: `DB-${sfx}`, nameUk: 'Бази даних', nameEn: 'Databases' },
            lecturerHrIds: [`L8-${sfx}`],
            groupCodes: [`KN8-${sfx}`],
          },
        ],
      }),
    );
    for (const n of ['S1', 'S2', 'S3']) ids[n] = (await prisma.user.findUniqueOrThrow({ where: { edeboId: `${n}-${sfx}` } })).id;
    for (const n of ['L', 'H', 'IT', 'AHR', 'CMD', 'ADM', 'CH']) ids[n] = (await prisma.user.findUniqueOrThrow({ where: { hrId: `${n}8-${sfx}` } })).id;
    courseChannelId = (await prisma.courseOffering.findFirstOrThrow({ where: { externalId: `CO8-${sfx}` }, include: { channel: true } })).channel!.id;

    for (const n of ['S1', 'S2', 'S3', 'L', 'H', 'AHR', 'CMD']) await login(n, { sub: `sub8-${n}-${sfx}`, email: n.startsWith('S') ? `${n.toLowerCase()}-${sfx}@puet.test` : `${n.toLowerCase()}8-${sfx}@puet.test`, amr: ['pwd'] });
    for (const n of ['IT', 'ADM', 'CH']) await login(n, { sub: `sub8-${n}-${sfx}`, email: `${n.toLowerCase()}8-${sfx}@puet.test`, amr: ['pwd', 'otp'] });
    await login('P', { sub: `sub8-P-${sfx}`, email: `p8-${sfx}@puet.test`, amr: ['pwd'] });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  // ── Bot inboxes ──────────────────────────────────

  it('each person sees only the bots the policy engine allows; unknown slugs are refused', async () => {
    const bots = async (who: string) => (await json<{ bot: string }[]>(await as(who).get('/bots'))).map((b) => b.bot).sort();
    expect(await bots('S1')).toEqual(['admissions', 'deanery', 'schedule', 'service-desk']);
    expect(await bots('L')).toEqual(['admissions', 'chancellery', 'schedule', 'service-desk']);
    expect((await as('S1').get('/bots/chancellery/messages')).status).toBe(403);
    expect((await as('L').get('/bots/deanery/messages')).status).toBe(403);
    expect((await as('S1').get('/bots/..%2Fadmin/messages')).status).toBe(403);
    expect((await as('S1').get('/bots/DEANERY/messages')).status).toBe(403);
  });

  // ── ЄДЕБО / Деканат ─────────────────────────────

  let requestId: string;

  it('deanery: a student orders a certificate once; the order leaves through the signed outbox with ids only', async () => {
    expect((await as('L').post('/deanery/requests', { type: 'STUDY_CERTIFICATE' })).status).toBe(403);
    // Mass assignment: the student id comes from the session, never from the body.
    expect((await as('S1').post('/deanery/requests', { type: 'STUDY_CERTIFICATE', studentId: ids.S2 })).status).toBe(400);
    const res = await as('S1').post('/deanery/requests', { type: 'STUDY_CERTIFICATE', copies: 2, purpose: 'Для військкомату' });
    expect(res.status).toBe(201);
    requestId = (await json<{ id: string }>(res)).id;
    expect((await as('S1').post('/deanery/requests', { type: 'STUDY_CERTIFICATE' })).status).toBe(409);

    const event = (await prisma.integrationOutbox.findMany({ where: { target: 'DEANERY', eventType: 'document.requested' } })).find(
      (e) => (e.payload as { requestId?: string }).requestId === requestId,
    )!;
    expect(event.payload).toMatchObject({ edeboId: `S1-${sfx}`, type: 'STUDY_CERTIFICATE', copies: 2 });
    expect(JSON.stringify(event.payload)).not.toContain('Студент');

    const outbox = app.get(OutboxService);
    for (let i = 0; i < 5 && (await prisma.integrationOutbox.findUniqueOrThrow({ where: { id: event.id } })).status !== 'SENT'; i++) await outbox.flush();
    const sent = outbound.find((s) => s.headers['idempotency-key'] === event.id)!;
    expect(sent.url).toBe('https://deanery.test/pulse');
    expect(
      verifySignature({ secret: DEANERY_SECRET, header: sent.headers['x-puet-signature'], body: Buffer.from(sent.body), nowSeconds: Math.floor(Date.now() / 1000), toleranceSeconds: 300 }),
    ).toEqual({ ok: true });
    expect(JSON.parse(sent.body)).toMatchObject({ id: event.id, type: 'document.requested', data: { requestId } });

    const card = (await messages('S1', 'deanery')).at(-1)!.card!;
    expect(card).toMatchObject({ kind: 'document_request', requestId, status: 'REQUESTED' });
  });

  it('outbox: a failing receiver is retried later with backoff, not dropped', async () => {
    const r = await json<{ id: string }>(await as('S2').post('/deanery/requests', { type: 'ACADEMIC_TRANSCRIPT' }));
    const event = (await prisma.integrationOutbox.findMany({ where: { target: 'DEANERY' }, orderBy: { createdAt: 'desc' }, take: 20 })).find(
      (e) => (e.payload as { requestId?: string }).requestId === r.id,
    )!;
    senderStatus = 503;
    try {
      for (let i = 0; i < 5 && (await prisma.integrationOutbox.findUniqueOrThrow({ where: { id: event.id } })).attempts === 0; i++) await app.get(OutboxService).flush();
    } finally {
      senderStatus = 200;
    }
    const after = await prisma.integrationOutbox.findUniqueOrThrow({ where: { id: event.id } });
    expect(after).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'http.503' });
    expect(after.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // The student cancels while it is still REQUESTED; another student cannot (IDOR).
    expect((await as('S1').post(`/deanery/requests/${r.id}/cancel`)).status).toBe(403);
    expect((await as('S2').post(`/deanery/requests/${r.id}/cancel`)).status).toBe(200);
  });

  it('deanery webhook: forged or misdirected calls are refused; progress reaches the student; the life cycle holds', async () => {
    const payload = { documents: [{ requestId, status: 'READY', note: 'Заберіть у каб. 214' }] };
    expect((await webhook('deanery', 'deanery', payload, 'x'.repeat(40))).status).toBe(401);
    expect((await webhook('schedule', 'deanery', payload)).status).toBe(403);
    expect((await webhook('edebo', 'deanery', payload)).status).toBe(403);
    const r = await ok(
      webhook('deanery', 'deanery', {
        ...payload,
        studyPlans: [
          { edeboId: `S1-${sfx}`, semesterCode: semester, status: 'NEEDS_CHANGES', credits: 58.5, note: 'Додайте вибіркову дисципліну' },
          { edeboId: `NOPE-${sfx}`, semesterCode: semester, status: 'APPROVED' },
        ],
      }),
    );
    expect(r.updated).toBe(1);
    expect(r.created).toBe(1);
    expect(r.errors).toEqual([{ index: 2, error: 'student.not_found' }]);
    const cards = (await messages('S1', 'deanery')).map((m) => m.card!);
    expect(cards).toContainEqual(expect.objectContaining({ kind: 'document_request', requestId, status: 'READY', note: 'Заберіть у каб. 214' }));
    expect(cards).toContainEqual(expect.objectContaining({ kind: 'study_plan', semester, status: 'NEEDS_CHANGES', credits: 58.5 }));
    expect((await json<{ status: string }[]>(await as('S1').get('/deanery/study-plan')))[0]!.status).toBe('NEEDS_CHANGES');
    // The deanery is already on it: the student can no longer cancel.
    expect((await as('S1').post(`/deanery/requests/${requestId}/cancel`)).status).toBe(409);
    // Back to IN_PROGRESS after READY is outside the life cycle.
    expect((await ok(webhook('deanery', 'deanery', { documents: [{ requestId, status: 'IN_PROGRESS' }] }))).errors).toEqual([{ index: 0, error: 'document.transition_refused' }]);
    // Tampering at rest: the trigger refuses it too.
    await expect(prisma.$executeRaw`UPDATE student_document_requests SET status = 'REQUESTED' WHERE id = ${requestId}::uuid`).rejects.toThrow();
    // Read markers.
    expect((await json<{ read: number }>(await as('S1').post('/bots/deanery/read'))).read).toBeGreaterThan(0);
  });

  // ── Розклад ПУЕТ ─────────────────────────────────

  it('schedule: changes reach the group and its lecturer only; links outside the allowlist are refused', async () => {
    const changes = [
      { externalId: `CH1-${sfx}`, courseExternalId: `CO8-${sfx}`, date: tomorrow, pair: 2, kind: 'ROOM_CHANGE', room: '3-214' },
      { externalId: `CH2-${sfx}`, groupCode: `KN8-${sfx}`, date: tomorrow, pair: 3, kind: 'ONLINE', link: 'https://moodle-puet.example/login' },
      { externalId: `CH3-${sfx}`, groupCode: `KN8-${sfx}`, date: tomorrow, pair: 4, kind: 'ONLINE', link: 'https://moodle.puet.edu.ua/mod/zoom/view.php?id=7' },
      { externalId: `CH4-${sfx}`, groupCode: `NOPE-${sfx}`, date: tomorrow, pair: 1, kind: 'CANCELLED' },
    ];
    const r = await ok(webhook('schedule', 'schedule', { changes }));
    expect(r.created).toBe(2);
    expect(r.errors).toEqual([
      { index: 1, error: 'link.not_allowed' },
      { index: 3, error: 'group.not_found' },
    ]);
    // A replay with a new idempotency key does not announce twice.
    expect((await ok(webhook('schedule', 'schedule', { changes: [changes[0]] }))).created).toBe(0);

    const mine = await json<{ changeId: string; room: string | null; link: string | null }[]>(await as('S1').get('/schedule/changes'));
    expect(mine.map((c) => c.room)).toContain('3-214');
    expect(mine.map((c) => c.link)).toContain('https://moodle.puet.edu.ua/mod/zoom/view.php?id=7');
    expect(await json<unknown[]>(await as('S3').get('/schedule/changes'))).toEqual([]);
    expect((await messages('L', 'schedule')).map((m) => m.card!.room)).toContain('3-214');
    expect((await messages('S2', 'schedule')).filter((m) => m.card!.kind === 'schedule_change')).toHaveLength(2);
    expect(await messages('S3', 'schedule')).toEqual([]);
    const change = await prisma.scheduleChange.findFirstOrThrow({ where: { externalId: `CH3-${sfx}` } });
    await expect(prisma.$executeRaw`UPDATE schedule_changes SET link = 'https://evil.example' WHERE id = ${change.id}::uuid`).rejects.toThrow();
  });

  // ── Service desk АГР та ІТ ──────────────────────

  it('service desk: a dormitory repair goes to the commandant, then to АГР, with the room hidden from АГР', async () => {
    expect((await as('S2').post('/service-desk/tickets', { category: 'DORMITORY', title: 'Тече кран', description: 'Тече кран у душовій' })).status).toBe(400);
    expect((await as('S1').post('/service-desk/tickets', { category: 'IT', title: 'Не працює Wi-Fi', description: 'Немає мережі' })).status).toBe(400);
    const res = await as('S1').post('/service-desk/tickets', { category: 'DORMITORY', title: 'Тече кран', description: 'Тече кран у душовій, другий поверх' });
    expect(res.status).toBe(201);
    const t = await json<{ id: string; room: string | null; dormitory: number }>(res);
    expect(t).toMatchObject({ room: `R8-${sfx}`, dormitory: 1 });

    // IDOR: neither another student nor the IT center can open it.
    expect((await as('S2').get(`/service-desk/tickets/${t.id}`)).status).toBe(403);
    expect((await as('IT').get(`/service-desk/tickets/${t.id}`)).status).toBe(403);
    expect((await json<{ id: string }[]>(await as('IT').get('/service-desk/queue'))).map((x) => x.id)).not.toContain(t.id);
    expect((await as('S1').get('/service-desk/queue')).status).toBe(403);
    expect((await as('S1').post(`/service-desk/tickets/${t.id}/handle`, { status: 'RESOLVED' })).status).toBe(403);

    const queue = await json<{ id: string; room: string | null }[]>(await as('CMD').get('/service-desk/queue'));
    expect(queue.find((x) => x.id === t.id)?.room).toBe(`R8-${sfx}`);
    expect((await as('CMD').post(`/service-desk/tickets/${t.id}/handle`, { forwardTo: 'FACILITIES', comment: 'Потрібен сантехнік' })).status).toBe(200);

    // АГР (a sub-unit handles it) sees the ticket, but not the room of the resident.
    const ahr = await json<{ id: string; room: string | null }[]>(await as('AHR').get('/service-desk/queue'));
    expect(ahr.find((x) => x.id === t.id)).toMatchObject({ room: null });
    expect((await json<{ room: string | null }>(await as('AHR').get(`/service-desk/tickets/${t.id}`))).room).toBeNull();
    expect((await as('AHR').post(`/service-desk/tickets/${t.id}/handle`, { status: 'REJECTED' })).status).toBe(400);
    expect((await as('AHR').post(`/service-desk/tickets/${t.id}/handle`, { status: 'RESOLVED', comment: 'Замінили змішувач' })).status).toBe(200);
    expect((await as('S1').post(`/service-desk/tickets/${t.id}/requester`, { action: 'REOPEN' })).status).toBe(400);
    expect((await as('S2').post(`/service-desk/tickets/${t.id}/requester`, { action: 'CONFIRM' })).status).toBe(403);
    expect((await as('S1').post(`/service-desk/tickets/${t.id}/requester`, { action: 'CONFIRM' })).status).toBe(200);
    expect((await json<{ status: string }>(await as('S1').get(`/service-desk/tickets/${t.id}`))).status).toBe('CLOSED');
    // The requester hears about every step taken by someone else.
    expect((await messages('S1', 'service-desk')).map((m) => m.card!.event)).toEqual(['forwarded', 'status']);
    expect((await messages('CMD', 'service-desk')).map((m) => m.card!.event)).toContain('created');
    await expect(prisma.$executeRaw`UPDATE service_tickets SET requester_id = ${ids.S2}::uuid WHERE id = ${t.id}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`DELETE FROM service_ticket_events WHERE ticket_id = ${t.id}::uuid`).rejects.toThrow();
  });

  it('service desk: an IT ticket lands in the IT center queue only', async () => {
    const t = await json<{ id: string }>(
      await as('L').post('/service-desk/tickets', { category: 'IT', priority: 'HIGH', title: 'Не працює проєктор', description: 'Проєктор не вмикається', location: 'ауд. 3-214' }),
    );
    expect((await json<{ id: string }[]>(await as('IT').get('/service-desk/queue'))).map((x) => x.id)).toContain(t.id);
    expect((await json<{ id: string }[]>(await as('AHR').get('/service-desk/queue'))).map((x) => x.id)).not.toContain(t.id);
    expect((await as('IT').post(`/service-desk/tickets/${t.id}/handle`, { assignToMe: true, status: 'IN_PROGRESS' })).status).toBe(200);
    expect((await as('L').post(`/service-desk/tickets/${t.id}/comments`, { comment: 'Буду в аудиторії до 14:00' })).status).toBe(201);
    expect((await json<{ status: string; assigneeName: string }>(await as('L').get(`/service-desk/tickets/${t.id}`))).status).toBe('IN_PROGRESS');
  });

  // ── ЕДО та Канцелярія ───────────────────────────

  it('chancellery: approvers are told when it is their turn, the approved order goes to the ЕДО, registration comes back', async () => {
    const up = await as('L').upload(courseChannelId, await plainPdf('Order'), 'nakaz.pdf');
    expect(up.status).toBe(201);
    const fileId = (await json<{ id: string }>(up)).id;
    await app.get(FilesService).process(fileId);
    const created = await as('L').post(`/files/${fileId}/approval-routes`, { title: `Наказ про практику ${sfx}`, steps: [{ approverId: ids.H, requireSignature: false }] });
    expect(created.status).toBe(201);
    const route = await json<{ id: string; currentStepId: string }>(created);
    expect((await messages('H', 'chancellery')).at(-1)!.card).toMatchObject({ kind: 'approval', routeId: route.id, event: 'your_turn' });

    const done = await as('H').post(`/files/${fileId}/approval-routes/${route.id}/steps/${route.currentStepId}/decision`, { decision: 'APPROVE' });
    expect(done.status).toBe(201);
    const event = (await prisma.integrationOutbox.findMany({ where: { target: 'EDO', eventType: 'order.approved' } })).find(
      (e) => (e.payload as { routeId?: string }).routeId === route.id,
    )!;
    expect((event.payload as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await messages('L', 'chancellery')).at(-1)!.card).toMatchObject({ routeId: route.id, event: 'approved' });

    const reg = { registrations: [{ routeId: route.id, registrationNo: `118-к/${sfx}`, registeredAt: new Date().toISOString() }] };
    expect((await webhook('deanery', 'edo', reg)).status).toBe(403);
    expect((await ok(webhook('edo', 'edo', reg))).updated).toBe(1);
    expect((await messages('L', 'chancellery')).at(-1)!.card).toMatchObject({ event: 'registered', registrationNo: `118-к/${sfx}` });
    expect((await messages('H', 'chancellery')).at(-1)!.card).toMatchObject({ event: 'registered' });
    const again = await ok(webhook('edo', 'edo', { registrations: [{ ...reg.registrations[0]!, registrationNo: 'OTHER' }, { routeId: randomUUID(), registrationNo: '1', registeredAt: new Date().toISOString() }] }));
    expect(again.errors).toEqual([
      { index: 0, error: 'route.already_registered' },
      { index: 1, error: 'route.not_found' },
    ]);
    await expect(prisma.$executeRaw`UPDATE approval_routes SET registration_no = 'FORGED' WHERE id = ${route.id}::uuid`).rejects.toThrow();
  });

  // ── AI-консультант приймальної комісії ──────────

  const RULES = `# Правила прийому до ПУЕТ ${sfx}

## 1. Загальні положення
Ці Правила визначають порядок і умови вступу до Полтавського університету економіки і торгівлі.

## 2. Строки прийому заяв
Прийом заяв і документів для вступу на навчання за ступенем бакалавра триває з 1 по 31 липня.

## 7. Поселення вступників
На час вступної кампанії вступникам надають місця в гуртожитку № 3. Код ${sfx}.
`;

  it('admissions: only the Admissions Office manages the rules; answers quote the active version', async () => {
    expect((await as('CH').get('/bots/admissions/kb')).status).toBe(403);
    expect((await as('S1').get('/bots/admissions/kb')).status).toBe(403);
    expect((await as('ADM').get('/bots/deanery/kb')).status).toBe(403);
    expect((await as('CH').post('/bots/admissions/kb', { title: 'Підробка', text: 'x'.repeat(200) })).status).toBe(403);
    const res = await as('ADM').post('/bots/admissions/kb', { title: `Правила прийому ${sfx}`, text: RULES });
    expect(res.status).toBe(201);
    const doc = await json<{ id: string; active: boolean; chunks: number }>(res);
    expect(doc.active).toBe(true);
    expect(doc.chunks).toBeGreaterThanOrEqual(3);

    const a = await as('S1').post('/bots/admissions/ask', { question: `Чи надають гуртожиток вступникам? ${sfx}` });
    expect(a.status).toBe(200);
    const answer = await json<{ mode: string; body: string; sources: { heading: string | null }[] }>(a);
    expect(answer.mode).toBe('extractive');
    expect(answer.body).toContain('гуртожитку № 3');
    expect(answer.sources[0]!.heading).toBe('7. Поселення вступників');
    const thread = await messages('S1', 'admissions');
    expect(thread.slice(-2).map((m) => m.direction)).toEqual(['USER', 'BOT']);
    const stored = await prisma.botMessage.findUniqueOrThrow({ where: { id: thread.at(-1)!.id } });
    expect(stored.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    // A new version that is not activated yet does not answer; activating swaps it in.
    const draft = await json<{ id: string }>(await as('ADM').post('/bots/admissions/kb', { title: `Чернетка ${sfx}`, text: RULES.replace('№ 3', '№ 4'), activate: false }));
    expect((await as('ADM').post(`/bots/admissions/kb/${draft.id}/activate`)).status).toBe(200);
    expect((await json<{ body: string }>(await as('S2').post('/bots/admissions/ask', { question: `гуртожиток ${sfx}` }))).body).toContain('№ 4');
    expect(await prisma.admissionsDocument.count({ where: { tenantId: stored.tenantId, active: true } })).toBe(1);
    expect((await as('ADM').post('/bots/admissions/kb/not-a-uuid/activate')).status).toBe(400);
    await expect(prisma.$executeRaw`UPDATE admissions_chunks SET text = 'Вступ без іспитів' WHERE document_id = ${draft.id}::uuid`).rejects.toThrow();
  });

  it('admissions: tsquery injection is harmless, other tenants never see the rules, and flooding is limited', async () => {
    const inj = await as('S3').post('/bots/admissions/ask', { question: `')) | !:* <-> '; DROP TABLE users; -- ${sfx}` });
    expect(inj.status).toBe(200);
    // Lyceum pupils ask their own institution's rules, not the university's.
    const lyc = await json<{ mode: string }>(await as('P').post('/bots/admissions/ask', { question: `гуртожиток вступникам ${sfx}` }));
    expect(lyc.mode).toBe('none');
    // S3 already asked once: two more pass, then the hourly limit (3) applies.
    expect((await as('S3').post('/bots/admissions/ask', { question: 'Строки прийому заяв?' })).status).toBe(200);
    expect((await as('S3').post('/bots/admissions/ask', { question: 'Строки прийому заяв?' })).status).toBe(200);
    expect((await as('S3').post('/bots/admissions/ask', { question: 'Строки прийому заяв?' })).status).toBe(429);
    expect((await as('S3').post('/bots/admissions/ask', { question: 'x' })).status).toBe(400);
  });

  it('bot messages: immutable at rest, deleted only once expired', async () => {
    const [mine] = await messages('S1', 'admissions');
    await expect(prisma.$executeRaw`UPDATE bot_messages SET body = 'forged' WHERE id = ${mine!.id}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`DELETE FROM bot_messages WHERE id = ${mine!.id}::uuid`).rejects.toThrow();
    const tenantId = (await prisma.user.findUniqueOrThrow({ where: { id: ids.S3! } })).tenantId;
    const old = await prisma.botMessage.create({ data: { tenantId, userId: ids.S3!, bot: 'ADMISSIONS', direction: 'USER', body: 'old', expiresAt: new Date(Date.now() - 1000) } });
    expect(await app.get(BotInboxService).purgeExpired()).toBeGreaterThanOrEqual(1);
    expect(await prisma.botMessage.findUnique({ where: { id: old.id } })).toBeNull();
  });
});
