/**
 * Phase 5 security tests against a real PostgreSQL (migrated + seeded). They
 * exercise the endpoints the web client relies on, from the attacker's side:
 * IDOR on people, files, annotations, certificates and approval routes; minor
 * isolation in the directory; signature replay, bit flips and tampering at rest.
 *
 *   RUN_DB_TESTS=1 DATABASE_URL=... pnpm --filter @puet/api test
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@puet/database';
import { createCsr, generateSigningKeyPair, hexToBytes, signDigest } from '@puet/signing';
import { randomUUID } from 'node:crypto';
import type { webcrypto } from 'node:crypto';
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

interface Card {
  id: string;
  fullNameUk: string;
  [k: string]: unknown;
}

describe.skipIf(!enabled)('Phase 5 security (PostgreSQL)', () => {
  let app: INestApplication;
  let base: string;
  let ca: CaMaterial;
  const store = new MemoryObjectStore();
  const prisma = new PrismaClient();
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const keys: Record<string, { pair: webcrypto.CryptoKeyPair; pem: string; certId: string }> = {};
  let courseChannelId: string;

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

  async function uploadReady(who: string, name: string) {
    const res = await as(who).upload(courseChannelId, await plainPdf(`PUET document ${randomUUID()}`), `${name}.pdf`);
    expect(res.status).toBe(201);
    const dto = (await res.json()) as { id: string };
    await app.get(FilesService).process(dto.id);
    return dto.id;
  }

  async function enroll(who: string) {
    const pair = await generateSigningKeyPair();
    const res = await as(who).post('/me/certificates', { csr: await createCsr(pair) });
    expect(res.status).toBe(201);
    const cert = (await res.json()) as { id: string; certificatePem: string };
    keys[who] = { pair, pem: cert.certificatePem, certId: cert.id };
  }

  async function signatureFor(who: string, fileId: string) {
    const info = (await (await as(who).get(`/files/${fileId}/signing-info`)).json()) as { sha256: string };
    return signDigest(hexToBytes(info.sha256), keys[who]!.pair.privateKey, keys[who]!.pem);
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

    await webhook('hr', 'hr/staff', {
      records: [
        {
          hrId: `L-${sfx}`,
          corporateId: `L-${sfx}`,
          email: `l-${sfx}@puet.test`,
          fullNameUk: `Викладачка П'ята ${sfx}`,
          phone: '+380501234567',
          position: 'Доцент',
          primaryDepartmentCode: 'COMPUTER_SCIENCE_IT',
          roles: [{ role: 'LECTURER' }],
        },
        { hrId: `H-${sfx}`, corporateId: `H-${sfx}`, email: `h-${sfx}@puet.test`, fullNameUk: `Завідувач П'ятий ${sfx}`, position: 'Завідувач кафедри', primaryDepartmentCode: 'LAW', roles: [{ role: 'DEPARTMENT_HEAD', departmentCode: 'LAW' }] },
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
          lecturerHrIds: [`L-${sfx}`],
          groupCodes: [`KN5-${sfx}`],
        },
      ],
    });
    for (const n of ['S1', 'S2', 'S3', 'P']) ids[n] = (await prisma.user.findUniqueOrThrow({ where: { edeboId: `${n}-${sfx}` } })).id;
    ids.L = (await prisma.user.findUniqueOrThrow({ where: { hrId: `L-${sfx}` } })).id;
    ids.H = (await prisma.user.findUniqueOrThrow({ where: { hrId: `H-${sfx}` } })).id;
    courseChannelId = (await prisma.courseOffering.findFirstOrThrow({ where: { externalId: `CO5-${sfx}` }, include: { channel: true } })).channel!.id;
    for (const n of ['S1', 'S2', 'S3', 'L', 'H', 'P']) await login(n, { sub: `sub-${n}-${sfx}`, email: `${n.toLowerCase()}-${sfx}@puet.test`, amr: ['pwd'] });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  // ── People: directory, cards, privacy ───────────────────────────

  it('minor isolation: the directory and profile cards never reveal a lyceum pupil outside the lyceum', async () => {
    const search = (await (await as('S1').get(`/directory?q=${encodeURIComponent(`Учень Ліцею ${sfx}`)}`)).json()) as Card[];
    expect(search).toEqual([]);
    const lecturer = (await (await as('L').get(`/directory?q=${encodeURIComponent(sfx)}`)).json()) as Card[];
    expect(lecturer.map((c) => c.id)).not.toContain(ids.P);
    // Ids the client already knows: the pupil is silently dropped, a classmate is returned.
    const cards = (await (await as('S1').post('/directory/cards', { userIds: [ids.P, ids.S2] })).json()) as Card[];
    expect(cards.map((c) => c.id)).toEqual([ids.S2]);
    expect((await as('S1').get(`/users/${ids.P}`)).status).toBe(403);
    expect((await as('L').get(`/users/${ids.P}/presence`)).status).toBe(403);
    // And the pupil does not see university students either.
    const pupil = (await (await as('P').get(`/directory?q=${encodeURIComponent(`Студент S1 ${sfx}`)}`)).json()) as Card[];
    expect(pupil).toEqual([]);
    expect((await as('P').get(`/users/${ids.S1}`)).status).toBe(403);
  });

  it('privacy: a profile card carries no phone, e-mail, birth date or corporate id; the phone is self or HR only', async () => {
    const res = await as('S1').get(`/users/${ids.L}`);
    expect(res.status).toBe(200);
    const card = (await res.json()) as Card;
    expect(card.fullNameUk).toContain("Викладачка П'ята");
    for (const k of ['phone', 'email', 'birthDate', 'corporateId', 'edeboId', 'hrId', 'oidcSubject']) expect(card).not.toHaveProperty(k);
    expect(JSON.stringify(card)).not.toContain('+380');
    expect((await as('S1').get(`/users/${ids.L}/phone`)).status).toBe(403);
    expect(await (await as('L').get(`/users/${ids.L}/phone`)).json()).toEqual({ phone: '+380501234567' });
    // Uniform denial: an unknown id looks the same as a hidden person.
    const unknown = await as('S1').get(`/users/${randomUUID()}`);
    expect([403, 404]).toContain(unknown.status);
  });

  it('IDOR: ids in the path are validated and resolved server-side; malformed ids never reach a query', async () => {
    expect((await as('S1').get('/users/not-a-uuid')).status).toBe(403);
    expect((await as('S1').post('/directory/cards', { userIds: ["' OR 1=1 --"] })).status).toBe(400);
    expect((await as('S1').get('/directory?q=a')).status).toBe(400);
    const me = (await (await as('S1').get('/auth/me')).json()) as Record<string, unknown>;
    expect(me.fullNameUk).toBe(`Студент S1 ${sfx}`);
    for (const k of ['phone', 'email', 'birthDate']) expect(me).not.toHaveProperty(k);
  });

  // ── Files, annotations, approval routes ─────────────────────────

  it('IDOR: annotations of a file are invisible to outsiders, private ones to other members, and only authors change them', async () => {
    const fileId = await uploadReady('L', 'Лекція');
    const mine = await as('L').post(`/files/${fileId}/annotations`, { page: 1, kind: 'note', rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.05 }], text: 'Чернетка' });
    expect(mine.status).toBe(201);
    const privateId = ((await mine.json()) as { id: string }).id;
    const shared = await as('L').post(`/files/${fileId}/annotations`, { page: 1, kind: 'highlight', visibility: 'SHARED', rects: [{ x: 0.1, y: 0.3, w: 0.5, h: 0.05 }] });
    const sharedId = ((await shared.json()) as { id: string }).id;

    expect((await as('S3').get(`/files/${fileId}/annotations`)).status).toBe(403);
    const seen = (await (await as('S1').get(`/files/${fileId}/annotations`)).json()) as { id: string }[];
    expect(seen.map((a) => a.id)).toEqual([sharedId]);
    expect((await as('S1').patch(`/files/${fileId}/annotations/${sharedId}`, { text: 'змінено' })).status).toBe(403);
    expect((await as('S1').del(`/files/${fileId}/annotations/${privateId}`)).status).toBe(403);
    // An annotation id from this file cannot be reached through another file id.
    const other = await uploadReady('S1', 'Інший');
    expect((await as('L').patch(`/files/${other}/annotations/${privateId}`, { text: 'x' })).status).toBe(403);
  });

  it('IDOR: only the current approver decides; others cannot decide, cancel or reach the file through the route', async () => {
    const fileId = await uploadReady('L', 'Наказ');
    const res = await as('L').post(`/files/${fileId}/approval-routes`, { title: 'Погодження наказу', steps: [{ approverId: ids.H, requireSignature: false }] });
    expect(res.status).toBe(201);
    const route = (await res.json()) as { id: string; steps: { id: string }[] };
    const step = route.steps[0]!.id;
    const decide = (who: string) => as(who).post(`/files/${fileId}/approval-routes/${route.id}/steps/${step}/decision`, { decision: 'APPROVE' });
    expect((await decide('S1')).status).toBe(403);
    expect((await decide('S3')).status).toBe(403);
    expect((await as('S1').post(`/files/${fileId}/approval-routes/${route.id}/cancel`)).status).toBe(403);
    // The approver (not a member of the course) may view this one file, not the channel.
    expect((await as('H').get(`/files/${fileId}/view`)).status).toBe(200);
    expect((await as('H').get(`/channels/${courseChannelId}/messages`)).status).toBe(403);
    expect((await as('H').get(`/channels/${courseChannelId}/files`)).status).toBe(403);
    const inbox = (await (await as('H').get('/me/approvals')).json()) as { id: string }[];
    expect(inbox.map((r) => r.id)).toContain(route.id);
    expect((await decide('H')).status).toBe(201);
    expect((await decide('H')).status).toBe(409);
  });

  it('IDOR: certificates of other people cannot be listed or revoked', async () => {
    await enroll('L');
    expect((await as('S1').post(`/me/certificates/${keys.L!.certId}/revoke`, {})).status).toBe(403);
    const list = (await (await as('S1').get('/me/certificates')).json()) as { id: string }[];
    expect(list.map((c) => c.id)).not.toContain(keys.L!.certId);
  });

  // ── Signature tampering ─────────────────────────────────────────

  it('signature tampering: a valid signature cannot be replayed on another document, and a flipped bit is refused', async () => {
    const a = await uploadReady('L', 'Документ А');
    const b = await uploadReady('L', 'Документ Б');
    const sigA = await signatureFor('L', a);
    // Replay of A's signature onto B (same signer, same certificate).
    expect((await as('L').post(`/files/${b}/signatures`, { provider: 'INTERNAL_PKI', signature: sigA })).status).toBe(422);
    // One flipped bit inside the CMS.
    const raw = Buffer.from(sigA, 'base64');
    raw[raw.length - 10] = raw[raw.length - 10]! ^ 0x01;
    expect((await as('L').post(`/files/${a}/signatures`, { provider: 'INTERNAL_PKI', signature: raw.toString('base64') })).status).toBe(422);
    // Truncated / garbage input.
    expect((await as('L').post(`/files/${a}/signatures`, { provider: 'INTERNAL_PKI', signature: raw.subarray(0, 40).toString('base64') })).status).toBe(422);
    expect((await as('L').post(`/files/${a}/signatures`, { provider: 'INTERNAL_PKI', signature: sigA })).status).toBe(201);
  });

  it('signature tampering at rest: altered stored bytes are never served or signed, and signatures are append-only', async () => {
    const fileId = await uploadReady('L', 'Протокол');
    const sig = await signatureFor('L', fileId);
    expect((await as('L').post(`/files/${fileId}/signatures`, { provider: 'INTERNAL_PKI', signature: sig })).status).toBe(201);

    const row = await prisma.fileObject.findUniqueOrThrow({ where: { id: fileId } });
    const key = [...store.objects.keys()].find((k) => k.endsWith(row.sanitizedKey!))!;
    const original = store.objects.get(key)!;
    const body = Buffer.from(original.body);
    const mid = Math.floor(body.length / 2);
    body[mid] = body[mid]! ^ 0xff;
    store.objects.set(key, { ...original, body });
    try {
      expect((await as('S1').get(`/files/${fileId}/view`)).status).toBe(409);
      expect((await as('L').get(`/files/${fileId}/signing-info`)).status).toBe(409);
      expect((await as('L').get(`/files/${fileId}/verification`)).status).toBe(409);
    } finally {
      store.objects.set(key, original);
    }
    const p = (await (await as('L').get(`/files/${fileId}/verification`)).json()) as { document: { integrity: string }; signatures: { valid: boolean }[] };
    expect(p.document.integrity).toBe('intact');
    expect(p.signatures.map((s) => s.valid)).toEqual([true]);

    // The database itself refuses to rewrite a signature (append-only trigger).
    await expect(prisma.$executeRaw`UPDATE document_signatures SET signed_digest = ${'0'.repeat(64)} WHERE file_id = ${fileId}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`DELETE FROM document_signatures WHERE file_id = ${fileId}::uuid`).rejects.toThrow();
  });
});
