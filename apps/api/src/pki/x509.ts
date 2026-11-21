import * as asn1js from 'asn1js';
import { createHash, randomBytes, type webcrypto as nodeWebcrypto } from 'node:crypto';
import * as pkijs from 'pkijs';

/**
 * X.509 building blocks for the internal university CA (УЕП, CLAUDE.md §1.3).
 *
 * No cryptography is implemented here: keys, signatures and hashes come from
 * WebCrypto, and ASN.1 / X.509 / CRL / OCSP encoding from PKI.js. Node `crypto`
 * is used only for SHA-256 fingerprints and CSPRNG serial numbers.
 *
 * Algorithms: ECDSA P-256 with SHA-256 for the CA and for user keys.
 */

const webcrypto = globalThis.crypto;
pkijs.setEngine('puet', new pkijs.CryptoEngine({ name: 'puet', crypto: webcrypto }));

export const OID = {
  commonName: '2.5.4.3',
  country: '2.5.4.6',
  organization: '2.5.4.10',
  organizationalUnit: '2.5.4.11',
  title: '2.5.4.12',
  uid: '0.9.2342.19200300.100.1.1',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectKeyIdentifier: '2.5.29.14',
  authorityKeyIdentifier: '2.5.29.35',
  crlDistributionPoints: '2.5.29.31',
  crlNumber: '2.5.29.20',
  crlReason: '2.5.29.21',
  authorityInfoAccess: '1.3.6.1.5.5.7.1.1',
  ocsp: '1.3.6.1.5.5.7.48.1',
  ocspBasic: '1.3.6.1.5.5.7.48.1.1',
  ocspNonce: '1.3.6.1.5.5.7.48.1.2',
  caIssuers: '1.3.6.1.5.5.7.48.2',
  /** id-kp-documentSigning (RFC 9336). */
  documentSigning: '1.3.6.1.5.5.7.3.36',
  ecPublicKey: '1.2.840.10045.2.1',
  p256: '1.2.840.10045.3.1.7',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
} as const;

const EC_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export interface CaMaterial {
  certificate: pkijs.Certificate;
  certificateDer: Buffer;
  certificatePem: string;
  privateKey: nodeWebcrypto.CryptoKey;
  /** SHA-256(SubjectPublicKeyInfo), truncated: AuthorityKeyIdentifier of issued certificates. */
  keyId: Buffer;
}

export interface SubjectProfile {
  userId: string;
  fullName: string;
  /** Position (staff) or "Студент" / "Учень". */
  title: string;
  /** Department, institute or org unit name. */
  unit?: string;
}

export interface PkiUrls {
  crl: string;
  ocsp: string;
  caIssuers: string;
}

// ───────────── PEM / DER ─────────────

export function toPem(der: ArrayBuffer | Uint8Array, label: string): string {
  const b64 = Buffer.from(der instanceof Uint8Array ? der : new Uint8Array(der)).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
}

export function fromPem(pem: string, label: string): Buffer {
  const re = new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`);
  const m = re.exec(pem);
  if (!m) throw new Error(`Not a PEM ${label}`);
  return Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64');
}

export const ab = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export function parseCertificate(der: Uint8Array): pkijs.Certificate {
  return pkijs.Certificate.fromBER(ab(der));
}

export function serialHex(cert: pkijs.Certificate): string {
  return Buffer.from(cert.serialNumber.valueBlock.valueHexView).toString('hex').replace(/^(00)+(?=.)/, '');
}

export function dnString(name: pkijs.RelativeDistinguishedNames): string {
  const short: Record<string, string> = {
    [OID.commonName]: 'CN',
    [OID.country]: 'C',
    [OID.organization]: 'O',
    [OID.organizationalUnit]: 'OU',
    [OID.title]: 'T',
    [OID.uid]: 'UID',
  };
  return name.typesAndValues
    .map((tv) => `${short[tv.type] ?? tv.type}=${String((tv.value as asn1js.Utf8String).valueBlock.value).replace(/([,+=\\])/g, '\\$1')}`)
    .join(', ');
}

export function subjectValue(name: pkijs.RelativeDistinguishedNames, oid: string): string | undefined {
  const tv = name.typesAndValues.find((t) => t.type === oid);
  return tv ? String((tv.value as asn1js.Utf8String).valueBlock.value) : undefined;
}

function rdn(entries: [string, string][]): pkijs.RelativeDistinguishedNames {
  return new pkijs.RelativeDistinguishedNames({
    typesAndValues: entries.map(
      ([type, value]) =>
        new pkijs.AttributeTypeAndValue({
          type,
          value: type === OID.country ? new asn1js.PrintableString({ value }) : new asn1js.Utf8String({ value }),
        }),
    ),
  });
}

function randomSerial(): asn1js.Integer {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0]! & 0x7f) | 0x01; // positive, no leading zero byte
  return new asn1js.Integer({ valueHex: ab(bytes) });
}

function keyIdOf(spki: pkijs.PublicKeyInfo): Buffer {
  // RFC 7093 method 1: leftmost 160 bits of SHA-256 over the subjectPublicKey bits.
  return createHash('sha256').update(spki.subjectPublicKey.valueBlock.valueHexView).digest().subarray(0, 20);
}

function keyUsage(bits: number[]): asn1js.BitString {
  let value = 0;
  for (const b of bits) value |= 0x80 >> b;
  const highest = Math.max(...bits);
  return new asn1js.BitString({ valueHex: ab(Uint8Array.of(value)), unusedBits: 7 - highest });
}

const ext = (extnID: string, critical: boolean, value: asn1js.BaseBlock | { toSchema(): asn1js.BaseBlock }) =>
  new pkijs.Extension({
    extnID,
    critical,
    extnValue: ('toSchema' in value ? value.toSchema() : value).toBER(false),
  });

function isP256(spki: pkijs.PublicKeyInfo): boolean {
  const params = spki.algorithm.algorithmParams as asn1js.ObjectIdentifier | undefined;
  return spki.algorithm.algorithmId === OID.ecPublicKey && params?.valueBlock?.toString() === OID.p256;
}

// ───────────── CA ─────────────

/** Creates a self-signed root for the internal CA. Run once, offline (scripts/init-ca.ts). */
export async function createRootCa(opts: { commonName: string; years: number; now?: Date }) {
  const keys = (await webcrypto.subtle.generateKey(EC_P256, true, ['sign', 'verify'])) as nodeWebcrypto.CryptoKeyPair;
  const now = opts.now ?? new Date();
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = randomSerial();
  const name = rdn([
    [OID.country, 'UA'],
    [OID.organization, 'Полтавський університет економіки і торгівлі'],
    [OID.commonName, opts.commonName],
  ]);
  cert.subject = name;
  cert.issuer = name;
  cert.notBefore.value = new Date(now.getTime() - 60_000);
  cert.notAfter.value = new Date(now.getTime() + opts.years * 365 * 86_400_000);
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  const kid = keyIdOf(cert.subjectPublicKeyInfo);
  cert.extensions = [
    ext(OID.basicConstraints, true, new pkijs.BasicConstraints({ cA: true, pathLenConstraint: 0 })),
    ext(OID.keyUsage, true, keyUsage([5, 6])), // keyCertSign, cRLSign
    ext(OID.subjectKeyIdentifier, false, new asn1js.OctetString({ valueHex: ab(kid) })),
  ];
  await cert.sign(keys.privateKey, 'SHA-256');
  const der = Buffer.from(cert.toSchema(true).toBER(false));
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  return { certificatePem: toPem(der, 'CERTIFICATE'), privateKeyPem: toPem(pkcs8, 'PRIVATE KEY') };
}

/** Imports the CA. The private key becomes a non-extractable WebCrypto key. */
export async function loadCa(certificatePem: string, privateKeyPem: string): Promise<CaMaterial> {
  const certificateDer = fromPem(certificatePem, 'CERTIFICATE');
  const certificate = parseCertificate(certificateDer);
  const privateKey = await webcrypto.subtle.importKey('pkcs8', ab(fromPem(privateKeyPem, 'PRIVATE KEY')), EC_P256, false, ['sign']);
  if (!isP256(certificate.subjectPublicKeyInfo)) throw new Error('The internal CA must use ECDSA P-256');
  return { certificate, certificateDer, certificatePem: toPem(certificateDer, 'CERTIFICATE'), privateKey, keyId: keyIdOf(certificate.subjectPublicKeyInfo) };
}

// ───────────── Issuance ─────────────

export class CsrRejectedError extends Error {}

export interface ParsedCsr {
  csr: pkijs.CertificationRequest;
  publicKeySha256: string;
}

/** Parses a PKCS#10 CSR and checks proof of possession. Only ECDSA P-256 keys are accepted. */
export async function parseCsr(der: Uint8Array): Promise<ParsedCsr> {
  let csr: pkijs.CertificationRequest;
  try {
    csr = pkijs.CertificationRequest.fromBER(ab(der));
  } catch {
    throw new CsrRejectedError('Malformed CSR');
  }
  if (!isP256(csr.subjectPublicKeyInfo)) throw new CsrRejectedError('Only ECDSA P-256 keys are accepted');
  let ok = false;
  try {
    ok = await csr.verify();
  } catch {
    ok = false;
  }
  if (!ok) throw new CsrRejectedError('CSR signature is invalid');
  return { csr, publicKeySha256: sha256Hex(Buffer.from(csr.subjectPublicKeyInfo.toSchema().toBER(false))) };
}

/**
 * Issues an end-entity certificate. The subject comes only from the user's
 * profile, never from the CSR: the CSR contributes its public key alone.
 */
export async function issueCertificate(
  ca: CaMaterial,
  csr: pkijs.CertificationRequest,
  profile: SubjectProfile,
  validity: { notBefore: Date; notAfter: Date },
  urls: PkiUrls,
) {
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = randomSerial();
  cert.issuer = ca.certificate.subject;
  cert.subject = rdn([
    [OID.country, 'UA'],
    [OID.organization, 'Полтавський університет економіки і торгівлі'],
    ...(profile.unit ? ([[OID.organizationalUnit, profile.unit]] as [string, string][]) : []),
    [OID.title, profile.title],
    [OID.commonName, profile.fullName],
    [OID.uid, profile.userId],
  ]);
  cert.notBefore.value = validity.notBefore;
  cert.notAfter.value = validity.notAfter;
  cert.subjectPublicKeyInfo = csr.subjectPublicKeyInfo;

  const uri = (value: string) => new pkijs.GeneralName({ type: 6, value });
  cert.extensions = [
    ext(OID.basicConstraints, true, new pkijs.BasicConstraints({ cA: false })),
    ext(OID.keyUsage, true, keyUsage([0, 1])), // digitalSignature, nonRepudiation
    ext(OID.extKeyUsage, false, new pkijs.ExtKeyUsage({ keyPurposes: [OID.documentSigning] })),
    ext(OID.subjectKeyIdentifier, false, new asn1js.OctetString({ valueHex: ab(keyIdOf(csr.subjectPublicKeyInfo)) })),
    ext(OID.authorityKeyIdentifier, false, new pkijs.AuthorityKeyIdentifier({ keyIdentifier: new asn1js.OctetString({ valueHex: ab(ca.keyId) }) })),
    ext(
      OID.crlDistributionPoints,
      false,
      new pkijs.CRLDistributionPoints({
        distributionPoints: [new pkijs.DistributionPoint({ distributionPoint: [uri(urls.crl)] })],
      }),
    ),
    ext(
      OID.authorityInfoAccess,
      false,
      new pkijs.InfoAccess({
        accessDescriptions: [
          new pkijs.AccessDescription({ accessMethod: OID.ocsp, accessLocation: uri(urls.ocsp) }),
          new pkijs.AccessDescription({ accessMethod: OID.caIssuers, accessLocation: uri(urls.caIssuers) }),
        ],
      }),
    ),
  ];
  await cert.sign(ca.privateKey, 'SHA-256');
  const der = Buffer.from(cert.toSchema(true).toBER(false));
  return {
    der,
    pem: toPem(der, 'CERTIFICATE'),
    serialNumber: serialHex(cert),
    fingerprintSha256: sha256Hex(der),
    subjectDn: dnString(cert.subject),
    issuerDn: dnString(cert.issuer),
  };
}

/** True when `cert` was signed by the CA key and names the CA as issuer. */
export async function issuedBy(cert: pkijs.Certificate, ca: CaMaterial): Promise<boolean> {
  if (!cert.issuer.isEqual(ca.certificate.subject)) return false;
  try {
    return await cert.verify(ca.certificate);
  } catch {
    return false;
  }
}

// ───────────── Revocation: CRL and OCSP ─────────────

export type RevocationReasonName = 'UNSPECIFIED' | 'KEY_COMPROMISE' | 'AFFILIATION_CHANGED' | 'SUPERSEDED' | 'CESSATION_OF_OPERATION';
const REASON_CODE: Record<RevocationReasonName, number> = {
  UNSPECIFIED: 0,
  KEY_COMPROMISE: 1,
  AFFILIATION_CHANGED: 3,
  SUPERSEDED: 4,
  CESSATION_OF_OPERATION: 5,
};

export interface RevokedEntry {
  serialNumber: string;
  revokedAt: Date;
  reason: RevocationReasonName;
}

const serialInteger = (hex: string) => new asn1js.Integer({ valueHex: ab(Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex')) });

export async function buildCrl(ca: CaMaterial, revoked: RevokedEntry[], crlNumber: number, now: Date, nextUpdate: Date): Promise<Buffer> {
  const crl = new pkijs.CertificateRevocationList();
  crl.version = 1;
  crl.issuer = ca.certificate.subject;
  crl.thisUpdate = new pkijs.Time({ type: 0, value: now });
  crl.nextUpdate = new pkijs.Time({ type: 0, value: nextUpdate });
  if (revoked.length > 0) {
    crl.revokedCertificates = revoked.map(
      (r) =>
        new pkijs.RevokedCertificate({
          userCertificate: serialInteger(r.serialNumber),
          revocationDate: new pkijs.Time({ type: 0, value: r.revokedAt }),
          crlEntryExtensions: new pkijs.Extensions({
            extensions: [ext(OID.crlReason, false, new asn1js.Enumerated({ value: REASON_CODE[r.reason] }))],
          }),
        }),
    );
  }
  crl.crlExtensions = new pkijs.Extensions({
    extensions: [
      ext(OID.crlNumber, false, new asn1js.Integer({ value: crlNumber })),
      ext(OID.authorityKeyIdentifier, false, new pkijs.AuthorityKeyIdentifier({ keyIdentifier: new asn1js.OctetString({ valueHex: ab(ca.keyId) }) })),
    ],
  });
  await crl.sign(ca.privateKey, 'SHA-256');
  return Buffer.from(crl.toSchema(true).toBER(false));
}

export type OcspLookup = (serialNumber: string) => Promise<{ status: 'good' } | { status: 'revoked'; revokedAt: Date; reason: RevocationReasonName } | { status: 'unknown' }>;

const HASH_BY_OID: Record<string, string> = { [OID.sha1]: 'SHA-1', [OID.sha256]: 'SHA-256' };

function ocspError(status: number): Buffer {
  const resp = new pkijs.OCSPResponse();
  resp.responseStatus = new asn1js.Enumerated({ value: status });
  return Buffer.from(resp.toSchema().toBER(false));
}

/**
 * RFC 6960 responder. The CA signs responses itself. Requests for another
 * issuer get "unknown"; a malformed request gets malformedRequest (1).
 */
export async function answerOcsp(ca: CaMaterial, requestDer: Uint8Array, lookup: OcspLookup, now: Date): Promise<Buffer> {
  let req: pkijs.OCSPRequest;
  try {
    req = pkijs.OCSPRequest.fromBER(ab(requestDer));
  } catch {
    return ocspError(1);
  }
  const list = req.tbsRequest.requestList;
  if (list.length === 0 || list.length > 20) return ocspError(1);

  const issuerName = Buffer.from(ca.certificate.subject.toSchema().toBER(false));
  const issuerKey = Buffer.from(ca.certificate.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView);
  const responses: pkijs.SingleResponse[] = [];
  for (const r of list) {
    const id = r.reqCert;
    const alg = HASH_BY_OID[id.hashAlgorithm.algorithmId];
    let status: Awaited<ReturnType<OcspLookup>> = { status: 'unknown' };
    if (alg) {
      const nameHash = Buffer.from(await webcrypto.subtle.digest(alg, issuerName));
      const keyHash = Buffer.from(await webcrypto.subtle.digest(alg, issuerKey));
      const sameIssuer =
        nameHash.equals(Buffer.from(id.issuerNameHash.valueBlock.valueHexView)) &&
        keyHash.equals(Buffer.from(id.issuerKeyHash.valueBlock.valueHexView));
      if (sameIssuer) {
        const serial = Buffer.from(id.serialNumber.valueBlock.valueHexView).toString('hex').replace(/^(00)+(?=.)/, '');
        status = await lookup(serial);
      }
    }
    const certStatus =
      status.status === 'good'
        ? new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 } })
        : status.status === 'revoked'
          ? new asn1js.Constructed({
              idBlock: { tagClass: 3, tagNumber: 1 },
              value: [
                new asn1js.GeneralizedTime({ valueDate: status.revokedAt }),
                new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 0 }, value: [new asn1js.Enumerated({ value: REASON_CODE[status.reason] })] }),
              ],
            })
          : new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 2 } });
    responses.push(
      new pkijs.SingleResponse({
        certID: id,
        certStatus,
        thisUpdate: now,
        nextUpdate: new Date(now.getTime() + 3_600_000),
      }),
    );
  }

  const basic = new pkijs.BasicOCSPResponse();
  basic.tbsResponseData.responderID = ca.certificate.subject;
  basic.tbsResponseData.producedAt = now;
  basic.tbsResponseData.responses = responses;
  const nonce = req.tbsRequest.requestExtensions?.find((e) => e.extnID === OID.ocspNonce);
  if (nonce) basic.tbsResponseData.responseExtensions = [nonce];
  basic.certs = [ca.certificate];
  await basic.sign(ca.privateKey, 'SHA-256');

  const resp = new pkijs.OCSPResponse();
  resp.responseStatus = new asn1js.Enumerated({ value: 0 });
  resp.responseBytes = new pkijs.ResponseBytes({
    responseType: OID.ocspBasic,
    response: new asn1js.OctetString({ valueHex: basic.toSchema().toBER(false) }),
  });
  return Buffer.from(resp.toSchema().toBER(false));
}
