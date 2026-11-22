/**
 * End-to-end tests of Phase 9 against a real PostgreSQL (migrated + seeded):
 * anonymous appeals to trust services (pseudonyms with their own E2EE device),
 * and the other Phase 9 guardrails.
 *
 *   RUN_DB_TESTS=1 DATABASE_URL=... pnpm --filter @puet/api test
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@puet/database';
import { HttpTransport, PulseCrypto } from '@puet/e2ee';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule, REDIS } from '../../src/app.module';
import { OIDC_PROVIDER, type IdTokenClaims, type OidcProvider } from '../../src/auth/oidc.service';
import { APP_CONFIG, loadConfig } from '../../src/config/config';
import { FilesService } from '../../src/files/files.service';
import { FakeScanner, MALWARE_SCANNER } from '../../src/files/malware-scanner';
import { MemoryObjectStore, OBJECT_STORE } from '../../src/files/object-store';
import { sign } from '../../src/integrations/hmac';
import { DIGEST_STORE, MemoryDigestStore } from '../../src/notifications/digest.store';
import { CA_LOADER } from '../../src/pki/pki.service';
import { createRootCa, loadCa, type CaMaterial } from '../../src/pki/x509';
import { MemoryRealtimeBus, REALTIME_BUS } from '../../src/realtime/realtime.bus';
import { MemorySessionStore, SESSION_STORE } from '../../src/session/session.store';
import { plainPdf } from '../fixtures/pdfs';

const enabled = process.env.RUN_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const WEB = 'https://pulse.test';
const SERVER_NAME = 'pulse.test';
const sfx = randomUUID().slice(0, 8).toUpperCase();

const clients = {
  hr: { id: randomUUID(), secret: 'h'.repeat(40), tenantCode: 'PUET_MAIN', kinds: ['HR_STAFF', 'TEACHING_LOAD', 'OFFBOARDING'] },
  edebo: { id: randomUUID(), secret: 'e'.repeat(40), tenantCode: 'PUET_MAIN', kinds: ['EDEBO_STUDENTS', 'OFFBOARDING'] },
  lyceum: { id: randomUUID(), secret: 'l'.repeat(40), tenantCode: 'PUET_LYCEUM', kinds: ['EDEBO_STUDENTS', 'HR_STAFF'] },
};

let nextClaims: IdTokenClaims = { sub: 'nobody' };
const fakeOidc: OidcProvider = {
  authorizationUrl: async (p) => `https://sso.test/auth?state=${p.state}${p.acr ? `&acr_values=${p.acr}` : ''}`,
  exchange: async () => nextClaims,
  endSessionUrl: async () => undefined,
};

interface Appeal {
  id: string;
  alias: string;
  status: string;
  channelId: string;
  pseudonymId: string;
  service: { id: string };
}

describe.skipIf(!enabled)('Phase 9 end-to-end (PostgreSQL)', () => {
  let app: INestApplication;
  let base: string;
  let ca: CaMaterial;
  const store = new MemoryObjectStore();
  const prisma = new PrismaClient();
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let ombudsmanId: string;
  let courseChannelId: string;

  async function http(path: string, init: RequestInit & { cookie?: string; persona?: string } = {}) {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set('cookie', init.cookie);
    if (init.persona) headers.set('x-pulse-persona', init.persona);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (init.method && init.method !== 'GET') headers.set('origin', WEB);
    return fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' });
  }
  const as = (who: string, persona?: string) => ({
    get: (path: string) => http(path, { cookie: cookies[who]!, ...(persona ? { persona } : {}) }),
    post: (path: string, body: unknown = {}) => http(path, { method: 'POST', cookie: cookies[who]!, body: JSON.stringify(body), ...(persona ? { persona } : {}) }),
    upload: (channelId: string, bytes: Buffer, name: string) =>
      http(`/channels/${channelId}/files`, {
        method: 'POST',
        cookie: cookies[who]!,
        body: bytes,
        headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) },
      }),
  });
  const json = async <T>(res: Response) => (await res.json()) as T;

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
    return res.json();
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
      E2EE_SERVER_NAME: SERVER_NAME,
      TRUST_INTAKE_SECRET: 't'.repeat(48),
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
      .useValue(new MemoryRealtimeBus())
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
    const main = await prisma.tenant.findUniqueOrThrow({ where: { code: 'PUET_MAIN' } });
    ombudsmanId = (await prisma.orgUnit.findFirstOrThrow({ where: { tenantId: main.id, code: 'OMBUDSMAN' } })).id;

    await webhook('hr', 'hr/staff', {
      records: [
        { hrId: `O-${sfx}`, corporateId: `O-${sfx}`, email: `o-${sfx}@puet.test`, fullNameUk: 'Омбудсмен Тест', position: 'Студентський омбудсмен', orgUnitCodes: ['OMBUDSMAN'], roles: [{ role: 'TRUST_SERVICE_OFFICER', orgUnitCode: 'OMBUDSMAN' }] },
        { hrId: `L-${sfx}`, corporateId: `L-${sfx}`, email: `l-${sfx}@puet.test`, fullNameUk: 'Викладач Дев’ять', position: 'Доцент', primaryDepartmentCode: 'COMPUTER_SCIENCE_IT', roles: [{ role: 'LECTURER' }] },
      ],
    });
    const student = (n: string, group: string) => ({
      edeboId: `${n}-${sfx}`,
      corporateId: `${n}-${sfx}`,
      email: `${n.toLowerCase()}-${sfx}@puet.test`,
      fullNameUk: `Студент ${n}`,
      birthDate: '2004-05-01',
      educationLevel: 'BACHELOR',
      instituteCode: 'NNI_DAYTIME',
      groupCode: group,
      courseYear: 2,
    });
    await webhook('edebo', 'edebo/students', { records: [student('S1', `KN9-${sfx}`), student('S2', `KN9-${sfx}`), student('X', `EK9-${sfx}`)] });
    await webhook('hr', 'teaching-load', {
      semester: { code: `S9-${sfx}`, startsOn: '2026-09-01', endsOn: '2027-01-31', isCurrent: true },
      offerings: [{ externalId: `CO9-${sfx}`, departmentCode: 'COMPUTER_SCIENCE_IT', discipline: { code: `AL-${sfx}`, nameUk: 'Алгоритми', nameEn: 'Algorithms' }, lecturerHrIds: [`L-${sfx}`], groupCodes: [`KN9-${sfx}`] }],
    });
    for (const n of ['S1', 'S2', 'X']) ids[n] = (await prisma.user.findUniqueOrThrow({ where: { edeboId: `${n}-${sfx}` } })).id;
    ids.O = (await prisma.user.findUniqueOrThrow({ where: { hrId: `O-${sfx}` } })).id;
    ids.L = (await prisma.user.findUniqueOrThrow({ where: { hrId: `L-${sfx}` } })).id;
    courseChannelId = (await prisma.courseOffering.findFirstOrThrow({ where: { externalId: `CO9-${sfx}` }, include: { channel: true } })).channel!.id;
    for (const n of ['S1', 'S2', 'X', 'L']) await login(n, { sub: `sub-${n}-${sfx}`, email: `${n.toLowerCase()}-${sfx}@puet.test`, amr: ['pwd'] });
    await login('O', { sub: `sub-O-${sfx}`, email: `o-${sfx}@puet.test`, amr: ['pwd', 'otp'] });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  // ── Anonymous appeals to trust services ───────────────────────

  async function openAppeal(who: string) {
    const res = await as(who).post(`/trust-services/${ombudsmanId}/appeals`);
    expect(res.status).toBe(201);
    return json<Appeal>(res);
  }

  it('anonymity: officers see an alias, never the person; nothing about the pseudonym names them', async () => {
    const services = await json<{ enabled: boolean; services: { id: string; code: string }[] }>(await as('S1').get('/trust-services'));
    expect(services.enabled).toBe(true);
    expect(services.services.map((s) => s.code)).toContain('OMBUDSMAN');
    const appeal = await openAppeal('S1');
    expect(appeal.alias).toMatch(/^[A-Z0-9]{4}$/);

    // The officer's channel list has the room; its members are the pseudonym and the officers.
    const members = await json<{ userId: string }[]>(await as('O').get(`/channels/${appeal.channelId}/members`));
    const memberIds = members.map((m) => m.userId);
    expect(memberIds).toContain(appeal.pseudonymId);
    expect(memberIds).toContain(ids.O);
    expect(memberIds).not.toContain(ids.S1);
    const cards = await json<{ id: string; fullNameUk: string; email?: string }[]>(await as('O').post('/directory/cards', { userIds: [appeal.pseudonymId] }));
    expect(cards).toEqual([expect.objectContaining({ id: appeal.pseudonymId, fullNameUk: `Анонімний заявник · ${appeal.alias}` })]);
    expect(JSON.stringify(cards)).not.toContain(`S1-${sfx}`);

    // De-anonymization: the database row carries an HMAC tag, the channel has no creator, the audit names the pseudonym.
    const row = await prisma.anonymousCase.findUniqueOrThrow({ where: { id: appeal.id } });
    expect(row.requesterTag).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(ids.S1!);
    expect((await prisma.channel.findUniqueOrThrow({ where: { id: appeal.channelId } })).createdById).toBeNull();
    const audit = await prisma.auditLog.findMany({ where: { resourceId: appeal.channelId } });
    expect(JSON.stringify(audit, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(ids.S1!);
    // Pseudonyms are never found by directory search.
    expect(await json<unknown[]>(await as('O').get(`/directory?q=${encodeURIComponent('Анонімний заявник')}`))).toEqual([]);
  });

  it('IDOR: only the person behind an appeal can act as its pseudonym; the pseudonym can do nothing else', async () => {
    const appeal = await openAppeal('S2');
    // Another student, or an officer, cannot act as the pseudonym.
    expect((await as('S1', appeal.pseudonymId).get(`/channels/${appeal.channelId}/messages`)).status).toBe(403);
    expect((await as('O', appeal.pseudonymId).get(`/channels/${appeal.channelId}/messages`)).status).toBe(403);
    expect((await as('S2', 'not-a-uuid').get('/e2ee/whoami')).status).toBe(403);
    expect((await http('/e2ee/whoami', { persona: appeal.pseudonymId })).status).toBe(403); // no session at all
    // The real account is not a member of the room.
    expect((await as('S2').get(`/channels/${appeal.channelId}/messages`)).status).toBe(403);

    const p = as('S2', appeal.pseudonymId);
    expect(await json<{ userId: string }>(await p.get('/e2ee/whoami'))).toEqual({ userId: `@${appeal.pseudonymId}:${SERVER_NAME}` });
    expect((await p.get(`/channels/${appeal.channelId}/messages`)).status).toBe(200);
    // Scope: no directory, no DMs, no other channels, no files, no nested appeals.
    expect((await p.get('/directory?q=Студент')).status).toBe(403);
    expect((await p.post(`/users/${ids.O}/direct`)).status).toBe(403);
    expect((await p.post('/channels', { type: 'PRIVATE_GROUP', nameUk: 'x', memberIds: [ids.O] })).status).toBe(403);
    expect((await p.get(`/channels/${courseChannelId}/messages`)).status).toBe(403);
    expect((await p.post(`/trust-services/${ombudsmanId}/appeals`)).status).toBe(403);
    expect((await p.get('/me/appeals')).status).toBe(403);
    // Plaintext is refused in the mandatory E2EE room.
    expect((await p.post(`/channels/${appeal.channelId}/messages`, { clientMessageId: randomUUID(), body: 'plain' })).status).toBeGreaterThanOrEqual(400);
    // The database refuses to put a pseudonym anywhere else.
    await expect(prisma.channelMember.create({ data: { channelId: courseChannelId, userId: appeal.pseudonymId } })).rejects.toThrow();
  });

  it('E2EE: the pseudonym and the officer exchange Megolm messages through their own devices', async () => {
    const appeal = await openAppeal('S1');
    const device = async (who: string, userId: string, persona?: string) => {
      const res = await as(who, persona).post('/e2ee/devices', { label: persona ? 'Анонімний пристрій' : `${who} laptop` });
      expect(res.status).toBe(201);
      const { deviceId } = (await res.json()) as { deviceId: string };
      const transport = new HttpTransport(base, deviceId, fetch as never, () => ({ cookie: cookies[who]!, origin: WEB, ...(persona ? { 'x-pulse-persona': persona } : {}) }));
      return { deviceId, crypto: await PulseCrypto.create({ userId, serverName: SERVER_NAME, deviceId, transport }) };
    };
    const anon = await device('S1', appeal.pseudonymId, appeal.pseudonymId);
    const officer = await device('O', ids.O!);
    const members = (await json<{ userId: string }[]>(await as('S1', appeal.pseudonymId).get(`/channels/${appeal.channelId}/members`))).map((m) => m.userId);
    const enc = await anon.crypto.encrypt(appeal.channelId, members, { msgtype: 'm.text', body: 'Мене цькують у гуртожитку' });
    const sent = await as('S1', appeal.pseudonymId).post(`/channels/${appeal.channelId}/messages`, { ...enc, clientMessageId: randomUUID(), senderDeviceId: anon.deviceId });
    expect(sent.status).toBe(201);
    const msg = await json<{ id: string; senderId: string }>(sent);
    expect(msg.senderId).toBe(appeal.pseudonymId);

    // The key directory gives the officer the pseudonym's device only: no device of the real account.
    const keys = await json<{ device_keys: Record<string, Record<string, unknown>> }>(
      await as('O').post('/e2ee/keys/query', { device_keys: { [`@${appeal.pseudonymId}:${SERVER_NAME}`]: [], [`@${ids.S1}:${SERVER_NAME}`]: [] } }),
    );
    expect(Object.keys(keys.device_keys[`@${appeal.pseudonymId}:${SERVER_NAME}`] ?? {})).toEqual([anon.deviceId]);
    expect(keys.device_keys[`@${ids.S1}:${SERVER_NAME}`] ?? {}).toEqual({});

    await officer.crypto.sync();
    const [fetched] = await json<{ id: string; senderId: string; createdAt: string; ciphertext: string }[]>(await as('O').get(`/channels/${appeal.channelId}/messages?limit=1`));
    const plain = await officer.crypto.decrypt({ id: fetched!.id, channelId: appeal.channelId, senderId: fetched!.senderId, createdAt: fetched!.createdAt, ciphertext: fetched!.ciphertext });
    expect(plain.content.body).toBe('Мене цькують у гуртожитку');
    const stored = await prisma.message.findUniqueOrThrow({ where: { id: msg.id } });
    expect(stored.body).toBeNull();
    anon.crypto.close();
    officer.crypto.close();
  });

  it('closing: the requester or an officer closes the appeal and the room becomes read-only', async () => {
    const a = await openAppeal('S2');
    expect((await as('S1').post(`/me/appeals/${a.id}/close`)).status).toBe(403); // not theirs
    expect((await as('L').post(`/channels/${a.channelId}/appeal/close`)).status).toBe(403); // not an officer of the room
    const closed = await json<Appeal>(await as('S2').post(`/me/appeals/${a.id}/close`));
    expect(closed.status).toBe('CLOSED');
    expect((await as('S2', a.pseudonymId).get(`/channels/${a.channelId}/messages`)).status).toBe(200);
    expect((await as('S2', a.pseudonymId).post(`/channels/${a.channelId}/messages`, { clientMessageId: randomUUID(), ciphertext: 'x', scheme: 'MEGOLM', senderDeviceId: randomUUID() })).status).toBe(403);
    const b = await openAppeal('S2');
    expect((await as('O').post(`/channels/${b.channelId}/appeal/close`)).status).toBe(201);
    const mine = await json<Appeal[]>(await as('S2').get('/me/appeals'));
    expect(mine.filter((x) => x.status === 'OPEN').map((x) => x.id)).not.toContain(b.id);
    // A closed case stays closed (database guardrail).
    await expect(prisma.anonymousCase.update({ where: { id: b.id }, data: { status: 'OPEN', closedAt: null } })).rejects.toThrow();
  });

  it('offboarding: the appeals of an expelled student close and their pseudonyms stop working', async () => {
    const a = await openAppeal('X');
    await webhook('edebo', 'offboarding', { records: [{ edeboId: `X-${sfx}`, reason: 'EXPELLED' }] });
    expect((await prisma.anonymousCase.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('CLOSED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.pseudonymId } })).status).toBe('OFFBOARDED');
    expect((await as('X').get('/auth/me')).status).toBe(401);
    expect((await as('X', a.pseudonymId).get(`/channels/${a.channelId}/messages`)).status).toBe(403);
  });
});
