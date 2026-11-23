import { createCsr, generateSigningKeyPair, hexToBytes, signDetached, signDigest } from '@puet/signing';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { SignatureRejectedError, verifyDetachedCms } from '../src/pki/cms';
import {
  CsrRejectedError,
  OID,
  ab,
  answerOcsp,
  buildCrl,
  createRootCa,
  issueCertificate,
  issuedBy,
  loadCa,
  parseCertificate,
  parseCsr,
  subjectValue,
  type CaMaterial,
} from '../src/pki/x509';

const urls = { crl: 'https://pulse.test/api/pki/crl', ocsp: 'https://pulse.test/api/pki/ocsp', caIssuers: 'https://pulse.test/api/pki/ca.crt' };
const profile = { userId: '0b6c1f1e-1111-4111-8111-111111111111', fullName: "Мар'яна Іваненко", title: 'Доцент', unit: 'Кафедра комп’ютерних наук' };
const year = (from: Date) => ({ notBefore: from, notAfter: new Date(from.getTime() + 365 * 86_400_000) });
const b64 = (s: string) => Buffer.from(s, 'base64');

let ca: CaMaterial;
let other: CaMaterial;

async function enroll() {
  const keys = await generateSigningKeyPair();
  const { csr } = await parseCsr(b64(await createCsr(keys)));
  const issued = await issueCertificate(ca, csr, profile, year(new Date()), urls);
  return { keys, issued };
}

beforeAll(async () => {
  const root = await createRootCa({ commonName: 'PUET Internal CA (test)', years: 10 });
  ca = await loadCa(root.certificatePem, root.privateKeyPem);
  const rogue = await createRootCa({ commonName: 'PUET Internal CA (test)', years: 10 });
  other = await loadCa(rogue.certificatePem, rogue.privateKeyPem);
});

describe('internal university PKI (УЕП)', () => {
  it('the client key pair is non-extractable: the private key never leaves the device', async () => {
    const keys = await generateSigningKeyPair();
    expect(keys.privateKey.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('pkcs8', keys.privateKey)).rejects.toThrow();
  });

  it('issues a 1-year certificate whose subject comes from the profile, not from the CSR', async () => {
    const { issued } = await enroll();
    const cert = parseCertificate(issued.der);
    expect(subjectValue(cert.subject, OID.commonName)).toBe(profile.fullName);
    expect(subjectValue(cert.subject, OID.uid)).toBe(profile.userId);
    expect(subjectValue(cert.subject, OID.title)).toBe('Доцент');
    const days = (cert.notAfter.value.getTime() - cert.notBefore.value.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(365, 0);
    expect(await issuedBy(cert, ca)).toBe(true);
    expect(await issuedBy(cert, other)).toBe(false);
    const eku = cert.extensions!.find((e) => e.extnID === OID.extKeyUsage)!;
    expect((eku.parsedValue as pkijs.ExtKeyUsage).keyPurposes).toEqual([OID.documentSigning]);
    const bc = cert.extensions!.find((e) => e.extnID === OID.basicConstraints)!;
    expect((bc.parsedValue as pkijs.BasicConstraints).cA).toBe(false);
  });

  it('proof of possession: a CSR with a forged signature is rejected', async () => {
    const der = b64(await createCsr(await generateSigningKeyPair()));
    der[der.length - 5] = der[der.length - 5]! ^ 0x01;
    await expect(parseCsr(der)).rejects.toBeInstanceOf(CsrRejectedError);
  });

  it('rejects RSA keys and malformed CSRs', async () => {
    const rsa = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    )) as import('node:crypto').webcrypto.CryptoKeyPair;
    const csr = new pkijs.CertificationRequest();
    await csr.subjectPublicKeyInfo.importKey(rsa.publicKey);
    await csr.sign(rsa.privateKey, 'SHA-256');
    await expect(parseCsr(Buffer.from(csr.toSchema().toBER(false)))).rejects.toThrow(/P-256/);
    await expect(parseCsr(Buffer.from('not a csr'))).rejects.toBeInstanceOf(CsrRejectedError);
  });

  it('signs a document (CAdES-BES) and the server verifies it against the data', async () => {
    const { keys, issued } = await enroll();
    const doc = Buffer.from('%PDF-1.7 наказ № 42');
    const sig = b64(await signDetached(doc, keys.privateKey, issued.pem));
    const v = await verifyDetachedCms(sig, doc);
    expect(createHash('sha256').update(v.signerCertificateDer).digest('hex')).toBe(issued.fingerprintSha256);
    expect(v.claimedSigningTime).toBeInstanceOf(Date);
  });

  it('signature tampering: a signature over other data, or a modified signature, is rejected', async () => {
    const { keys, issued } = await enroll();
    const doc = Buffer.from('original');
    const sig = b64(await signDetached(doc, keys.privateKey, issued.pem));
    await expect(verifyDetachedCms(sig, Buffer.from('modified'))).rejects.toBeInstanceOf(SignatureRejectedError);
    const flipped = Buffer.from(sig);
    flipped[flipped.length - 10] = flipped[flipped.length - 10]! ^ 0x01;
    await expect(verifyDetachedCms(flipped, doc)).rejects.toBeInstanceOf(SignatureRejectedError);
    await expect(verifyDetachedCms(Buffer.from('garbage'), doc)).rejects.toBeInstanceOf(SignatureRejectedError);
  });

  it('a view-only client can sign the server digest; the result verifies against the bytes', async () => {
    const { keys, issued } = await enroll();
    const doc = Buffer.from('confidential');
    const digest = createHash('sha256').update(doc).digest('hex');
    const sig = b64(await signDigest(hexToBytes(digest), keys.privateKey, issued.pem));
    await expect(verifyDetachedCms(sig, doc)).resolves.toBeDefined();
  });

  it('certificate substitution: signing-certificate-v2 must name the embedded signer', async () => {
    const a = await enroll();
    const b = await enroll();
    // Signed with A's key but claiming B's certificate: the CMS signature check fails.
    const sig = b64(await signDetached(Buffer.from('x'), a.keys.privateKey, b.issued.pem));
    await expect(verifyDetachedCms(sig, Buffer.from('x'))).rejects.toBeInstanceOf(SignatureRejectedError);
  });

  it('publishes revocations in a signed CRL', async () => {
    const { issued } = await enroll();
    const now = new Date();
    const der = await buildCrl(ca, [{ serialNumber: issued.serialNumber, revokedAt: now, reason: 'AFFILIATION_CHANGED' }], 7, now, new Date(now.getTime() + 86_400_000));
    const crl = pkijs.CertificateRevocationList.fromBER(ab(der));
    expect(await crl.verify({ issuerCertificate: ca.certificate })).toBe(true);
    expect(crl.isCertificateRevoked(parseCertificate(issued.der))).toBe(true);
    const empty = pkijs.CertificateRevocationList.fromBER(ab(await buildCrl(ca, [], 8, now, new Date(now.getTime() + 1000))));
    expect(empty.revokedCertificates ?? []).toHaveLength(0);
  });

  it('answers OCSP requests: good, revoked and unknown issuer', async () => {
    const { issued } = await enroll();
    const cert = parseCertificate(issued.der);
    const request = async (issuer: pkijs.Certificate) => {
      const req = new pkijs.OCSPRequest();
      await req.createForCertificate(cert, { hashAlgorithm: 'SHA-1', issuerCertificate: issuer });
      const nonce = new asn1js.OctetString({ valueHex: ab(Buffer.from('nonce-123')) });
      req.tbsRequest.requestExtensions = [new pkijs.Extension({ extnID: OID.ocspNonce, extnValue: nonce.toBER(false) })];
      return Buffer.from(req.toSchema(true).toBER(false));
    };
    const parse = async (der: Buffer) => {
      const resp = pkijs.OCSPResponse.fromBER(ab(der));
      expect(resp.responseStatus.valueBlock.valueDec).toBe(0);
      const basic = new pkijs.BasicOCSPResponse({ schema: asn1js.fromBER(resp.responseBytes!.response.valueBlock.valueHexView).result });
      expect(await basic.verify({ trustedCerts: [ca.certificate] })).toBe(true);
      expect(basic.tbsResponseData.responseExtensions?.[0]?.extnID).toBe(OID.ocspNonce);
      return basic.getCertificateStatus(cert, ca.certificate);
    };
    const now = new Date();
    const good = await answerOcsp(ca, await request(ca.certificate), async () => ({ status: 'good' }), now);
    expect((await parse(good)).status).toBe(0);
    const revoked = await answerOcsp(ca, await request(ca.certificate), async () => ({ status: 'revoked', revokedAt: now, reason: 'KEY_COMPROMISE' }), now);
    expect((await parse(revoked)).status).toBe(1);
    let looked = false;
    const foreign = await answerOcsp(ca, await request(other.certificate), async () => ((looked = true), { status: 'good' }), now);
    expect(looked).toBe(false);
    const fr = pkijs.OCSPResponse.fromBER(ab(foreign));
    expect(fr.responseStatus.valueBlock.valueDec).toBe(0);
    const malformed = pkijs.OCSPResponse.fromBER(ab(await answerOcsp(ca, Buffer.from('junk'), async () => ({ status: 'good' }), now)));
    expect(malformed.responseStatus.valueBlock.valueDec).toBe(1);
  });
});
