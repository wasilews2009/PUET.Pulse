/**
 * End-to-end tests of Phase 4 against a real PostgreSQL (migrated + seeded):
 * quarantine + ClamAV + CDR, the secure viewer (watermark, DLP), JSON
 * annotations, the internal CA (CSR → certificate, CRL, OCSP), УЕП signatures
 * made with @puet/signing, КЕП through a fake QES gateway, approval routes and
 * the verification protocol with its public QR link.
 *
 *   RUN_DB_TESTS=1 DATABASE_URL=... pnpm --filter @puet/api test
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@puet/database';
import { createCsr, generateSigningKeyPair, hexToBytes, signDetached, signDigest } from '@puet/signing';
import * as pkijs from 'pkijs';
import { randomUUID } from 'node:crypto';
import type { webcrypto } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule, REDIS } from '../../src/app.module';
import { OIDC_PROVIDER, type IdTokenClaims, type OidcProvider } from '../../src/auth/oidc.service';
import { APP_CONFIG, loadConfig } from '../../src/config/config';
import { FilesService } from '../../src/files/files.service';
import { FakeScanner, MALWARE_SCANNER } from '../../src/files/malware-scanner';
import { MemoryObjectStore, OBJECT_STORE } from '../../src/files/object-store';
import { findActiveContent } from '../../src/files/pdf-sanitizer';
import { sign } from '../../src/integrations/hmac';
import { DIGEST_STORE, MemoryDigestStore } from '../../src/notifications/digest.store';
import { CA_LOADER } from '../../src/pki/pki.service';
import { EXTERNAL_SIGNATURE_PROVIDER, ExternalQesAdapter } from '../../src/pki/signature-provider';
import { createRootCa, fromPem, loadCa, type CaMaterial } from '../../src/pki/x509';
import { MemoryRealtimeBus, REALTIME_BUS } from '../../src/realtime/realtime.bus';
import { MemorySessionStore, SESSION_STORE } from '../../src/session/session.store';
import { maliciousPdf, outlinedPdf, plainPdf } from '../fixtures/pdfs';

const enabled = process.env.RUN_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const WEB = 'https://pulse.test';
const sfx = randomUUID().slice(0, 8).toUpperCase();
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

const clients = {
  hr: { id: randomUUID(), secret: 'h'.repeat(40), tenantCode: 'PUET_MAIN', kinds: ['HR_STAFF', 'TEACHING_LOAD', 'OFFBOARDING'] },
  edebo: { id: randomUUID(), secret: 'e'.repeat(40), tenantCode: 'PUET_MAIN', kinds: ['EDEBO_STUDENTS'] },
};

let nextClaims: IdTokenClaims = { sub: 'nobody' };
const fakeOidc: OidcProvider = {
  authorizationUrl: async (p) => `https://sso.test/auth?state=${p.state}${p.acr ? `&acr_values=${p.acr}` : ''}`,
  exchange: async () => nextClaims,
  endSessionUrl: async () => undefined,
};

interface FileDto {
  id: string;
  status: string;
  mimeType: string;
  sha256: string | null;
  pageCount: number | null;
  confidential: boolean;
}

describe.skipIf(!enabled)('Phase 4 end-to-end (PostgreSQL)', () => {
  let app: INestApplication;
  let base: string;
  let ca: CaMaterial;
  const store = new MemoryObjectStore();
  const scanner = new FakeScanner();
  const prisma = new PrismaClient();
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const keys: Record<string, { pair: webcrypto.CryptoKeyPair; pem: string; certId: string }> = {};
  let courseChannelId: string;
  let mainId: string;
  let qesAnswer: Record<string, unknown> = {};

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
    upload: (channelId: string, bytes: Buffer, name: string, confidential = false) =>
      http(`/channels/${channelId}/files${confidential ? '?confidential=true' : ''}`, {
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

  /** Uploads and runs the scan + CDR pipeline synchronously. */
  async function uploadReady(who: string, bytes: Buffer, name: string, confidential = false): Promise<FileDto> {
    const res = await as(who).upload(courseChannelId, bytes, name, confidential);
    expect(res.status).toBe(201);
    const dto = (await res.json()) as FileDto;
    await app.get(FilesService).process(dto.id);
    return (await (await as(who).get(`/files/${dto.id}`)).json()) as FileDto;
  }

  async function enroll(who: string) {
    const pair = await generateSigningKeyPair();
    const res = await as(who).post('/me/certificates', { csr: await createCsr(pair) });
    expect(res.status).toBe(201);
    const cert = (await res.json()) as { id: string; certificatePem: string };
    keys[who] = { pair, pem: cert.certificatePem, certId: cert.id };
    return cert;
  }

  async function signFile(who: string, fileId: string) {
    const info = (await (await as(who).get(`/files/${fileId}/signing-info`)).json()) as { sha256: string };
    const signature = await signDigest(hexToBytes(info.sha256), keys[who]!.pair.privateKey, keys[who]!.pem);
    return as(who).post(`/files/${fileId}/signatures`, { provider: 'INTERNAL_PKI', signature });
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
      FILE_MAX_MB: '5',
      FILE_SCAN_INLINE: 'false',
    });
    const qesFetch = (async () => new Response(JSON.stringify(qesAnswer), { status: 200 })) as unknown as typeof fetch;
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
      .useValue(scanner)
      .overrideProvider(CA_LOADER)
      .useValue(async () => ca)
      .overrideProvider(EXTERNAL_SIGNATURE_PROVIDER)
      .useValue(new ExternalQesAdapter({ url: 'https://qes-gw.test', token: 'gateway-token-123456' }, qesFetch))
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: ['error'] });
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    mainId = (await prisma.tenant.findUniqueOrThrow({ where: { code: 'PUET_MAIN' } })).id;

    await webhook('hr', 'hr/staff', {
      records: [
        { hrId: `L-${sfx}`, corporateId: `L-${sfx}`, email: `l-${sfx}@puet.test`, fullNameUk: 'Викладач Чотири', position: 'Доцент', primaryDepartmentCode: 'COMPUTER_SCIENCE_IT', roles: [{ role: 'LECTURER' }] },
        { hrId: `H-${sfx}`, corporateId: `H-${sfx}`, email: `h-${sfx}@puet.test`, fullNameUk: 'Завідувач Кафедри', position: 'Завідувач кафедри', primaryDepartmentCode: 'LAW', roles: [{ role: 'DEPARTMENT_HEAD', departmentCode: 'LAW' }] },
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
    await webhook('edebo', 'edebo/students', { records: [student('S1', `KN4-${sfx}`), student('S2', `KN4-${sfx}`), student('S3', `EK4-${sfx}`)] });
    await webhook('hr', 'teaching-load', {
      semester: { code: `S4-${sfx}`, startsOn: '2026-09-01', endsOn: '2027-01-31', isCurrent: true },
      offerings: [
        {
          externalId: `CO4-${sfx}`,
          departmentCode: 'COMPUTER_SCIENCE_IT',
          discipline: { code: `DB-${sfx}`, nameUk: 'Бази даних', nameEn: 'Databases' },
          lecturerHrIds: [`L-${sfx}`],
          groupCodes: [`KN4-${sfx}`],
        },
      ],
    });
    for (const n of ['S1', 'S2', 'S3']) ids[n] = (await prisma.user.findUniqueOrThrow({ where: { edeboId: `${n}-${sfx}` } })).id;
    ids.L = (await prisma.user.findUniqueOrThrow({ where: { hrId: `L-${sfx}` } })).id;
    ids.H = (await prisma.user.findUniqueOrThrow({ where: { hrId: `H-${sfx}` } })).id;
    const offering = await prisma.courseOffering.findFirstOrThrow({ where: { externalId: `CO4-${sfx}` }, include: { channel: true } });
    courseChannelId = offering.channel!.id;
    for (const n of ['S1', 'S2', 'S3', 'L', 'H']) await login(n, { sub: `sub-${n}-${sfx}`, email: `${n.toLowerCase()}-${sfx}@puet.test`, amr: ['pwd'] });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  // ── Files: quarantine, ClamAV, CDR ──────────────────────────────

  it('weaponized PDF: quarantined, scanned, rebuilt by CDR; only the sanitized copy is served', async () => {
    const res = await as('S1').upload(courseChannelId, await maliciousPdf(), 'Рахунок.pdf');
    expect(res.status).toBe(201);
    const pending = (await res.json()) as FileDto;
    expect(pending.status).toBe('PENDING');
    // Not released yet: nothing is served from quarantine.
    expect((await as('S1').get(`/files/${pending.id}/view`)).status).toBe(409);
    expect(await app.get(FilesService).process(pending.id)).toBe('released');

    const view = await as('S2').get(`/files/${pending.id}/view`);
    expect(view.status).toBe(200);
    expect(view.headers.get('content-type')).toBe('application/pdf');
    expect(view.headers.get('cache-control')).toContain('no-store');
    expect(view.headers.get('content-security-policy')).toContain('sandbox');
    const bytes = Buffer.from(await view.arrayBuffer());
    expect(findActiveContent(await PDFDocument.load(bytes))).toEqual([]);
    expect(bytes.toString('latin1')).not.toContain('app.alert');
    expect([...store.objects.keys()].some((k) => k.startsWith('quarantine/'))).toBe(false);
  });

  it('malware upload: an EICAR file is rejected, deleted from quarantine and never served', async () => {
    const res = await as('S1').upload(courseChannelId, Buffer.from(EICAR), 'eicar.txt');
    const dto = (await res.json()) as FileDto;
    expect(await app.get(FilesService).process(dto.id)).toBe('rejected');
    const row = await prisma.fileObject.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.scanStatus).toBe('INFECTED');
    expect(row.malwareName).toBe('Eicar-Test-Signature');
    expect((await as('S1').get(`/files/${dto.id}/download`)).status).toBe(409);
    expect(store.objects.has(`quarantine/${row.storageKey}`)).toBe(false);
  });

  it('fail closed: while the scanner is down the file stays in quarantine; the sweeper releases it later', async () => {
    scanner.available = false;
    const res = await as('S1').upload(courseChannelId, Buffer.from('Розклад консультацій'), 'schedule.txt');
    const dto = (await res.json()) as FileDto;
    expect(await app.get(FilesService).process(dto.id)).toBe('retry');
    expect((await as('S1').get(`/files/${dto.id}/download`)).status).toBe(409);
    scanner.available = true;
    await app.get(FilesService).processPending(new Date(Date.now() + 60_000));
    const dl = await as('S2').get(`/files/${dto.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toContain('attachment');
    expect(await dl.text()).toBe('Розклад консультацій');
  });

  it('refuses executables, oversize uploads and confidential non-PDFs', async () => {
    expect((await as('S1').upload(courseChannelId, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]), 'setup.exe')).status).toBe(415);
    expect((await as('S1').upload(courseChannelId, Buffer.alloc(6 * 1024 * 1024, 0x41), 'big.txt')).status).toBe(413);
    expect((await as('S1').upload(courseChannelId, Buffer.from('text'), 'a.txt', true)).status).toBe(400);
  });

  it('IDOR: a student outside the course cannot list, view, download or upload files there', async () => {
    const f = await uploadReady('S1', await plainPdf('Lab 1'), 'lab1.pdf');
    for (const path of [`/files/${f.id}`, `/files/${f.id}/view`, `/files/${f.id}/download`, `/channels/${courseChannelId}/files`, `/files/${f.id}/annotations`]) {
      expect((await as('S3').get(path)).status, path).toBe(403);
    }
    expect((await as('S3').upload(courseChannelId, await plainPdf(), 'x.pdf')).status).toBe(403);
  });

  it('DLP: a confidential PDF is view-only and every view is watermarked for the viewer', async () => {
    const f = await uploadReady('L', await plainPdf('Exam answers'), 'Відповіді.pdf', true);
    expect(f.confidential).toBe(true);
    expect((await as('S1').get(`/files/${f.id}/download`)).status).toBe(403);
    const view = await as('S1').get(`/files/${f.id}/view`);
    expect(view.status).toBe(200);
    const marked = Buffer.from(await view.arrayBuffer());
    const sanitized = await store.get('attachments', (await prisma.fileObject.findUniqueOrThrow({ where: { id: f.id } })).sanitizedKey!);
    expect(marked.equals(sanitized!)).toBe(false);
    expect(marked.length).toBeGreaterThan(sanitized!.length);
  });

  // ── Annotations ────────────────────────────────────────────────

  it('annotations: private notes stay private, shared ones are visible; only the author edits', async () => {
    const f = await uploadReady('S1', await plainPdf('Notes', 2), 'notes.pdf');
    const rect = [{ x: 0.1, y: 0.1, w: 0.3, h: 0.05 }];
    const mine = await as('S1').post(`/files/${f.id}/annotations`, { page: 1, kind: 'highlight', rects: rect });
    expect(mine.status).toBe(201);
    const shared = (await (await as('S1').post(`/files/${f.id}/annotations`, { page: 2, kind: 'comment', rects: rect, text: 'Див. п. 3', visibility: 'SHARED' })).json()) as { id: string };
    expect((await as('S1').post(`/files/${f.id}/annotations`, { page: 9, kind: 'note', rects: rect })).status).toBe(404);
    const seen = (await (await as('S2').get(`/files/${f.id}/annotations`)).json()) as { id: string }[];
    expect(seen.map((a) => a.id)).toEqual([shared.id]);
    expect((await as('S2').patch(`/files/${f.id}/annotations/${shared.id}`, { text: 'hacked' })).status).toBe(403);
    expect((await as('S1').patch(`/files/${f.id}/annotations/${shared.id}`, { text: 'Див. п. 4' })).status).toBe(200);
  });

  // ── Phase 9: viewer navigation and streaming ───────────────────

  it('viewer: table of contents from the original outline; byte ranges for ordinary PDFs, never for watermarked ones', async () => {
    const f = await uploadReady('S1', await outlinedPdf(), 'Кошторис.pdf');
    const meta = (await (await as('S2').get(`/files/${f.id}`)).json()) as { outline: { title: string; page: number }[] };
    expect(meta.outline.map((e) => e.page)).toEqual([1, 2, 3, 3]);

    const whole = await as('S2').get(`/files/${f.id}/view`);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    const size = Number(whole.headers.get('content-length'));
    const all = Buffer.from(await whole.arrayBuffer());
    expect(all.length).toBe(size);
    const part = await http(`/files/${f.id}/view`, { cookie: cookies.S2!, headers: { range: 'bytes=0-1023' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-1023/${size}`);
    expect(part.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.from(await part.arrayBuffer()).equals(all.subarray(0, 1024))).toBe(true);
    expect((await http(`/files/${f.id}/view`, { cookie: cookies.S2!, headers: { range: `bytes=${size}-` } })).status).toBe(416);
    // IDOR: ranges are authorized like any other view.
    expect((await http(`/files/${f.id}/view`, { cookie: cookies.S3!, headers: { range: 'bytes=0-10' } })).status).toBe(403);

    const secret = await uploadReady('L', await plainPdf('Salary'), 'Зарплата.pdf', true);
    const marked = await http(`/files/${secret.id}/view`, { cookie: cookies.S1!, headers: { range: 'bytes=0-9' } });
    expect(marked.status).toBe(200);
    expect(marked.headers.get('accept-ranges')).toBeNull();
  });

  it('IDOR: bookmarks are personal; nobody lists or deletes someone else\'s', async () => {
    const f = await uploadReady('S1', await plainPdf('Bookmarks', 3), 'bookmarks.pdf');
    const b = (await (await as('S1').post(`/files/${f.id}/bookmarks`, { page: 2, label: 'Таблиця 2' })).json()) as { id: string };
    expect((await as('S1').post(`/files/${f.id}/bookmarks`, { page: 9 })).status).toBe(404);
    expect((await as('S1').post(`/files/${f.id}/bookmarks`, { page: 2, label: 'Таблиця 2.1' })).status).toBe(201);
    expect(((await (await as('S1').get(`/files/${f.id}/bookmarks`)).json()) as { label: string }[]).map((x) => x.label)).toEqual(['Таблиця 2.1']);
    expect(await (await as('S2').get(`/files/${f.id}/bookmarks`)).json()).toEqual([]);
    expect((await http(`/files/${f.id}/bookmarks/${b.id}`, { method: 'DELETE', cookie: cookies.S2! })).status).toBe(403);
    expect((await as('S3').get(`/files/${f.id}/bookmarks`)).status).toBe(403);
    expect((await http(`/files/${f.id}/bookmarks/${b.id}`, { method: 'DELETE', cookie: cookies.S1! })).status).toBe(200);
  });

  // ── Internal CA and УЕП signatures ──────────────────────────────

  it('internal CA: issues a certificate from a CSR, bound to the profile; a reused key is refused', async () => {
    const cert = await enroll('S1');
    expect(cert.certificatePem).toContain('BEGIN CERTIFICATE');
    const row = await prisma.userCertificate.findUniqueOrThrow({ where: { id: cert.id } });
    expect(row.subjectDn).toContain('CN=Студент S1');
    expect(row.subjectDn).toContain(`UID=${ids.S1}`);
    // Re-certifying the same public key is refused; a new key supersedes the old certificate.
    expect((await as('S1').post('/me/certificates', { csr: await createCsr(keys.S1!.pair) })).status).toBe(409);
    const old = keys.S1!.certId;
    await enroll('S1');
    expect((await prisma.userCertificate.findUniqueOrThrow({ where: { id: old } })).revocationReason).toBe('SUPERSEDED');
    expect((await as('S1').post('/me/certificates', { csr: 'bm90IGEgY3NyIGF0IGFsbA==' })).status).toBe(400);
  });

  it('signs a released document with УЕП; tampering and foreign certificates are rejected', async () => {
    const f = await uploadReady('S1', await plainPdf('Application'), 'zayava.pdf');
    expect((await signFile('S1', f.id)).status).toBe(201);
    expect((await signFile('S1', f.id)).status).toBe(409);

    await enroll('S2');
    // Signature tampering: a signature over other bytes is refused.
    const other = await signDetached(Buffer.from('другий документ'), keys.S2!.pair.privateKey, keys.S2!.pem);
    expect((await as('S2').post(`/files/${f.id}/signatures`, { provider: 'INTERNAL_PKI', signature: other })).status).toBe(422);
    // Certificate theft: S2 submits a signature made with S1's certificate.
    const info = (await (await as('S1').get(`/files/${f.id}/signing-info`)).json()) as { sha256: string };
    const stolen = await signDigest(hexToBytes(info.sha256), keys.S1!.pair.privateKey, keys.S1!.pem);
    expect((await as('S2').post(`/files/${f.id}/signatures`, { provider: 'INTERNAL_PKI', signature: stolen })).status).toBe(422);
    // A certificate from another CA is not trusted.
    const rogueRoot = await createRootCa({ commonName: 'PUET Internal CA (test)', years: 1 });
    const rogue = await loadCa(rogueRoot.certificatePem, rogueRoot.privateKeyPem);
    const { parseCsr, issueCertificate } = await import('../../src/pki/x509');
    const pair = await generateSigningKeyPair();
    const { csr } = await parseCsr(Buffer.from(await createCsr(pair), 'base64'));
    const forged = await issueCertificate(rogue, csr, { userId: ids.S2!, fullName: 'Студент S2', title: 'Студент' }, { notBefore: new Date(Date.now() - 1000), notAfter: new Date(Date.now() + 86_400_000) }, { crl: 'x', ocsp: 'x', caIssuers: 'x' });
    const forgedSig = await signDigest(hexToBytes(info.sha256), pair.privateKey, forged.pem);
    expect((await as('S2').post(`/files/${f.id}/signatures`, { provider: 'INTERNAL_PKI', signature: forgedSig })).status).toBe(422);
    const denied = await prisma.auditLog.count({ where: { action: 'document.sign', resourceId: f.id, outcome: 'DENIED' } });
    expect(denied).toBe(3);
  });

  it('PAdES: a stamped copy signed on the device; drafts are personal, single-use and bound to the signer\'s certificate', async () => {
    const f = await uploadReady('S2', await plainPdf('Contract', 2), 'dogovir.pdf');
    const draft = (await (await as('S2').post(`/files/${f.id}/pades`)).json()) as { draftId: string; digest: string };
    expect(draft.digest).toMatch(/^[0-9a-f]{64}$/);
    // IDOR: another member cannot complete someone else's draft, even with a valid signature of their own.
    const s1sig = await signDigest(hexToBytes(draft.digest), keys.S1!.pair.privateKey, keys.S1!.pem, null);
    expect((await as('S1').post(`/files/${f.id}/pades/${draft.draftId}`, { signature: s1sig })).status).toBe(403);
    // Certificate theft: S2's draft signed with S1's key and certificate is refused.
    expect((await as('S2').post(`/files/${f.id}/pades/${draft.draftId}`, { signature: s1sig })).status).toBe(422);
    // Tampering: a signature over another digest is refused.
    const wrong = await signDigest(new Uint8Array(32).fill(7), keys.S2!.pair.privateKey, keys.S2!.pem, null);
    expect((await as('S2').post(`/files/${f.id}/pades/${draft.draftId}`, { signature: wrong })).status).toBe(422);

    const good = await signDigest(hexToBytes(draft.digest), keys.S2!.pair.privateKey, keys.S2!.pem, null);
    const done = await as('S2').post(`/files/${f.id}/pades/${draft.draftId}`, { signature: good });
    expect(done.status).toBe(201);
    const sig = (await done.json()) as { id: string; format: string; level: string };
    expect(sig).toMatchObject({ format: 'PAdES-B-B', level: 'УЕП' });
    // Single use: the draft is gone.
    expect((await as('S2').post(`/files/${f.id}/pades/${draft.draftId}`, { signature: good })).status).toBe(403);

    const copy = await as('S1').get(`/files/${f.id}/signatures/${sig.id}/signed.pdf`);
    expect(copy.status).toBe(200);
    expect(copy.headers.get('content-disposition')).toContain('attachment');
    const bytes = Buffer.from(await copy.arrayBuffer());
    const { extractPades } = await import('../../src/pki/pades');
    const { verifyDetachedCms } = await import('../../src/pki/cms');
    const x = extractPades(bytes);
    await expect(verifyDetachedCms(x.cms, x.content)).resolves.toBeTruthy();
    expect((await as('S3').get(`/files/${f.id}/signatures/${sig.id}/signed.pdf`)).status).toBe(403);

    const protocol = (await (await as('S1').get(`/files/${f.id}/verification`)).json()) as { signatures: { format: string; valid: boolean }[] };
    expect(protocol.signatures).toEqual([expect.objectContaining({ format: 'PAdES-B-B', valid: true })]);

    // View-only documents are signed as detached CAdES, never stamped and handed out.
    const secret = await uploadReady('L', await plainPdf('Payroll'), 'payroll.pdf', true);
    await enroll('L');
    expect((await as('L').post(`/files/${secret.id}/pades`)).status).toBe(400);
  });

  it('CRL and OCSP publish revocations of the internal CA', async () => {
    const cert = await enroll('S3');
    expect((await as('S3').post(`/me/certificates/${cert.id}/revoke`, { reason: 'KEY_COMPROMISE' })).status).toBe(201);
    expect((await as('S2').post(`/me/certificates/${keys.S1!.certId}/revoke`, {})).status).toBe(403);
    const crlRes = await http('/pki/crl');
    expect(crlRes.headers.get('content-type')).toBe('application/pkix-crl');
    const crl = pkijs.CertificateRevocationList.fromBER(await crlRes.arrayBuffer());
    expect(await crl.verify({ issuerCertificate: ca.certificate })).toBe(true);
    const certObj = pkijs.Certificate.fromBER(new Uint8Array(fromPem(cert.certificatePem, 'CERTIFICATE')).buffer);
    expect(crl.isCertificateRevoked(certObj)).toBe(true);

    const req = new pkijs.OCSPRequest();
    await req.createForCertificate(certObj, { hashAlgorithm: 'SHA-256', issuerCertificate: ca.certificate });
    const ocspRes = await http('/pki/ocsp', { method: 'POST', body: Buffer.from(req.toSchema(true).toBER(false)), headers: { 'content-type': 'application/ocsp-request' } });
    expect(ocspRes.status).toBe(200);
    const parsed = pkijs.OCSPResponse.fromBER(await ocspRes.arrayBuffer());
    expect((await parsed.getCertificateStatus(certObj, ca.certificate)).status).toBe(1); // revoked
    expect((await http('/pki/ca.crt')).status).toBe(200);
  });

  // ── Approval routes ─────────────────────────────────────────────

  it('approval route: approvers decide in order, approving needs their own signature, and the creator is notified', async () => {
    const f = await uploadReady('L', await plainPdf('Order'), 'nakaz.pdf');
    // Separation of duties and reachability.
    expect((await as('S1').post(`/files/${f.id}/approval-routes`, { title: 'x', steps: [{ approverId: ids.H }] })).status).toBe(403);
    expect((await as('L').post(`/files/${f.id}/approval-routes`, { title: 'x', steps: [{ approverId: ids.L }] })).status).toBe(400);
    // A student cannot be an approver (no document.approve).
    expect((await as('L').post(`/files/${f.id}/approval-routes`, { title: 'x', steps: [{ approverId: ids.S1 }] })).status).toBe(403);

    const created = await as('L').post(`/files/${f.id}/approval-routes`, { title: 'Наказ про практику', steps: [{ approverId: ids.H }] });
    expect(created.status).toBe(201);
    const route = (await created.json()) as { id: string; currentStepId: string };
    expect((await as('L').post(`/files/${f.id}/approval-routes`, { title: 'again', steps: [{ approverId: ids.H }] })).status).toBe(409);

    // H (another department, no oversight here) is not a member, but as the approver may view and sign this one file.
    expect((await as('H').get(`/files/${f.id}/view`)).status).toBe(200);
    expect((await as('H').get(`/channels/${courseChannelId}/files`)).status).toBe(403);
    const inbox = (await (await as('H').get('/me/approvals')).json()) as { id: string }[];
    expect(inbox.map((r) => r.id)).toContain(route.id);

    // A course member who is not an approver cannot decide.
    const decision = `/files/${f.id}/approval-routes/${route.id}/steps/${route.currentStepId}/decision`;
    expect((await as('S1').post(decision, { decision: 'APPROVE' })).status).toBe(403);
    expect((await as('H').post(decision, { decision: 'APPROVE' })).status).toBe(400); // signature required
    expect((await as('H').post(decision, { decision: 'REJECT' })).status).toBe(400); // comment required

    await enroll('H');
    const signed = await signFile('H', f.id);
    expect(signed.status).toBe(201);
    const sig = (await signed.json()) as { id: string; level: string };
    expect(sig.level).toBe('УЕП');
    const done = await as('H').post(decision, { decision: 'APPROVE', signatureId: sig.id, comment: 'Погоджено' });
    expect(done.status).toBe(201);
    expect(((await done.json()) as { status: string }).status).toBe('APPROVED');
    expect((await as('H').post(decision, { decision: 'APPROVE', signatureId: sig.id })).status).toBe(409);
  });

  // ── Verification protocol ──────────────────────────────────────

  it('verification protocol: signatures re-checked, QR link to a public check; later revocation keeps earlier signatures valid', async () => {
    const f = await uploadReady('L', await plainPdf('Protocol'), 'protocol.pdf');
    await enroll('L');
    expect((await signFile('L', f.id)).status).toBe(201);

    const res = await as('S1').get(`/files/${f.id}/verification`);
    expect(res.status).toBe(200);
    const p = (await res.json()) as { document: { integrity: string; sha256: string }; signatures: { valid: boolean; level: string }[]; verifyUrl: string; qrSvg: string };
    expect(p.document.integrity).toBe('intact');
    expect(p.signatures).toHaveLength(1);
    expect(p.signatures[0]).toMatchObject({ valid: true, level: 'УЕП' });
    expect(p.qrSvg).toContain('<svg');
    const verifyPath = new URL(p.verifyUrl).pathname; // /verify/<fileId>/<code>
    const pub = await http(verifyPath);
    expect(pub.status).toBe(200);
    const pubBody = (await pub.json()) as { document: Record<string, unknown> };
    expect(pubBody.document.fileName).toBeUndefined(); // minimal public data
    expect((await http(`${verifyPath.slice(0, -1)}${verifyPath.endsWith('A') ? 'B' : 'A'}`)).status).toBe(404);
    expect((await http(`/verify/${randomUUID()}/${verifyPath.split('/').pop()}`)).status).toBe(404);

    const served = Buffer.from(await (await as('S1').get(`/files/${f.id}/download`)).arrayBuffer());
    const check = await http(`${verifyPath}/check`, { method: 'POST', body: served, headers: { 'content-type': 'application/octet-stream' } });
    expect(await check.json()).toEqual({ matches: true });
    const tampered = await http(`${verifyPath}/check`, { method: 'POST', body: Buffer.concat([served, Buffer.from(' ')]), headers: { 'content-type': 'application/octet-stream' } });
    expect(await tampered.json()).toEqual({ matches: false });

    // Offboarding revokes the certificate afterwards: the earlier signature stays valid, the status shows the revocation.
    await webhook('hr', 'offboarding', { records: [{ hrId: `L-${sfx}`, reason: 'DISMISSED' }] });
    const after = (await (await as('S1').get(`/files/${f.id}/verification`)).json()) as { signatures: { valid: boolean; certificate: { status: string } }[] };
    expect(after.signatures[0]).toMatchObject({ valid: true, certificate: { status: 'REVOKED' } });

    const pdf = await as('S1').get(`/files/${f.id}/verification.pdf`);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect((await PDFDocument.load(Buffer.from(await pdf.arrayBuffer()))).getPageCount()).toBeGreaterThanOrEqual(1);
  });

  // ── КЕП via the QES gateway ─────────────────────────────────────

  it('КЕП: binding needs a valid qualified signature over our challenge by the profile holder; signing needs fresh OCSP + TSP', async () => {
    const qesRoot = await createRootCa({ commonName: 'Студент S2', years: 1 });
    const qesCert = fromPem(qesRoot.certificatePem, 'CERTIFICATE').toString('base64');
    const now = new Date();
    const good = {
      valid: true,
      format: 'CAdES-X-Long',
      qualified: true,
      signer: { certificate: qesCert, fullName: 'Студент S2' },
      ocsp: { status: 'good', checkedAt: now.toISOString() },
      tsp: { valid: true, time: now.toISOString() },
    };
    const { challenge } = (await (await as('S2').get('/me/certificates/qes/challenge')).json()) as { challenge: string };
    // Someone else's name on the qualified certificate is refused.
    qesAnswer = { ...good, signer: { certificate: qesCert, fullName: 'Інша Особа' } };
    expect((await as('S2').post('/me/certificates/qes', { challenge, signature: 'c2lnbmF0dXJlLWJ5dGVz' })).status).toBe(422);
    // A challenge issued to another user is refused.
    const foreign = (await (await as('S1').get('/me/certificates/qes/challenge')).json()) as { challenge: string };
    qesAnswer = good;
    expect((await as('S2').post('/me/certificates/qes', { challenge: foreign.challenge, signature: 'c2lnbmF0dXJlLWJ5dGVz' })).status).toBe(400);
    const bound = await as('S2').post('/me/certificates/qes', { challenge, signature: 'c2lnbmF0dXJlLWJ5dGVz' });
    expect(bound.status).toBe(201);

    const f = await uploadReady('S2', await plainPdf('QES'), 'qes.pdf');
    qesAnswer = { ...good, ocsp: { status: 'revoked', checkedAt: now.toISOString() } };
    expect((await as('S2').post(`/files/${f.id}/signatures`, { provider: 'EXTERNAL_QES', signature: 'c2lnbmF0dXJlLWJ5dGVz' })).status).toBe(422);
    qesAnswer = { ...good, tsp: null };
    expect((await as('S2').post(`/files/${f.id}/signatures`, { provider: 'EXTERNAL_QES', signature: 'c2lnbmF0dXJlLWJ5dGVz' })).status).toBe(422);
    qesAnswer = good;
    const ok = await as('S2').post(`/files/${f.id}/signatures`, { provider: 'EXTERNAL_QES', signature: 'c2lnbmF0dXJlLWJ5dGVz' });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { level: string; format: string }).level).toBe('КЕП');
  });
});
