import { createCsr, generateSigningKeyPair, signDigest } from '@puet/signing';
import { execFileSync } from 'node:child_process';
import type { webcrypto } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { sanitizePdf } from '../src/files/pdf-sanitizer';
import { verifyDetachedCms } from '../src/pki/cms';
import { checkSignatureField, embedCms, extractPades, PadesError, preparePades, type PadesStamp } from '../src/pki/pades';
import { createRootCa, issueCertificate, loadCa, parseCsr, type CaMaterial } from '../src/pki/x509';
import { plainPdf } from './fixtures/pdfs';

const urls = { crl: 'https://pulse.test/api/pki/crl', ocsp: 'https://pulse.test/api/pki/ocsp', caIssuers: 'https://pulse.test/api/pki/ca.crt' };
const profile = { userId: '0b6c1f1e-1111-4111-8111-111111111111', fullName: 'Олена Коваленко', title: 'Доцент', unit: 'Кафедра маркетингу' };
const stamp: PadesStamp = {
  signerName: profile.fullName,
  signerTitle: 'Доцент кафедри маркетингу',
  certificateSerial: '5A1F09C3',
  signedAt: new Date('2026-11-23T10:00:00Z'),
  verifyUrl: 'https://pulse.puet.edu.ua/verify/00000000-0000-4000-8000-000000000001/Qm9kZ2V0LXNhbXBsZS1jb2RlXw',
};
const pdfsig = ['/usr/bin/pdfsig', '/usr/local/bin/pdfsig'].find((p) => existsSync(p));

let ca: CaMaterial;
let signer: { keys: webcrypto.CryptoKeyPair; pem: string };

beforeAll(async () => {
  const root = await createRootCa({ commonName: 'PUET Internal CA (test)', years: 10 });
  ca = await loadCa(root.certificatePem, root.privateKeyPem);
  const keys = await generateSigningKeyPair();
  const { csr } = await parseCsr(Buffer.from(await createCsr(keys), 'base64'));
  const issued = await issueCertificate(ca, csr, profile, { notBefore: new Date(), notAfter: new Date(Date.now() + 365 * 86_400_000) }, urls);
  signer = { keys, pem: issued.pem };
});

async function signedCopy() {
  const base = (await sanitizePdf(await plainPdf('Order', 2))).bytes;
  const prepared = await preparePades(base, stamp);
  const cms = Buffer.from(await signDigest(new Uint8Array(prepared.digest), signer.keys.privateKey, signer.pem, null), 'base64');
  return { base, prepared, cms, signed: embedCms(prepared.pdf, cms) };
}

describe('PAdES with a visual QR stamp (internal УЕП)', () => {
  it('the byte ranges cover the whole file except the signature, and the CMS verifies over them', async () => {
    const { prepared, signed, cms } = await signedCopy();
    const [a, b, c, d] = prepared.byteRange;
    expect(a).toBe(0);
    expect(c + d).toBe(signed.length);
    expect(signed.length).toBe(prepared.pdf.length);
    const x = extractPades(signed);
    expect(x.cms.equals(cms)).toBe(true);
    const verified = await verifyDetachedCms(x.cms, x.content);
    expect(verified.claimedSigningTime).toBeUndefined(); // PAdES: the time is in /M, not in signed attributes
    expect(await checkSignatureField(signed)).toBe(true);
    // The stamped copy still opens and keeps its pages.
    expect((await PDFDocument.load(signed)).getPageCount()).toBe(2);
  });

  it('tampering: one changed byte inside the signed ranges breaks the signature', async () => {
    const { signed } = await signedCopy();
    const evil = Buffer.from(signed);
    const i = evil.indexOf('Contents') - 40;
    evil[i] = evil[i] === 0x20 ? 0x21 : 0x20;
    const x = extractPades(evil);
    await expect(verifyDetachedCms(x.cms, x.content)).rejects.toThrow();
  });

  it('shadow attack: bytes appended after the signature (an incremental update) are refused', async () => {
    const { signed } = await signedCopy();
    const appended = Buffer.concat([signed, Buffer.from('\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')]);
    expect(() => extractPades(appended)).toThrow(PadesError);
  });

  it('an unsigned placeholder or junk after the CMS is not a signature', async () => {
    const { prepared, signed } = await signedCopy();
    expect(() => extractPades(prepared.pdf)).toThrow(PadesError);
    const junk = Buffer.from(signed);
    junk.write('41', prepared.byteRange[2] - 3, 'latin1'); // last hex digits of the padding
    expect(() => extractPades(junk)).toThrow(PadesError);
  });

  it.skipIf(!pdfsig)('an independent PDF validator (poppler pdfsig) accepts the signature', async () => {
    const { signed } = await signedCopy();
    const dir = mkdtempSync(join(tmpdir(), 'pades-'));
    const file = join(dir, 'signed.pdf');
    writeFileSync(file, signed);
    let out = '';
    try {
      out = execFileSync(pdfsig!, [file], { encoding: 'utf8' });
    } catch (e) {
      // pdfsig exits non-zero when the certificate is not trusted locally; the signature itself is what we check.
      out = String((e as { stdout?: string }).stdout ?? '');
    }
    expect(out).toContain('ETSI.CAdES.detached');
    expect(out).toMatch(/Signature Validation: Signature is Valid/);
    expect(out).toMatch(/Signer Certificate Common Name: Олена Коваленко/);
  });
});
