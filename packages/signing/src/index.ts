import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

/**
 * Client side of the internal university PKI (УЕП, CLAUDE.md §1.3).
 *
 *  - The key pair is generated with WebCrypto as **non-extractable**: the
 *    private key can sign but can never be exported, so it never leaves the
 *    device. Store the CryptoKey in IndexedDB (structured clone keeps it opaque).
 *  - The server receives only a PKCS#10 CSR (public key + proof of possession).
 *  - Documents are signed as detached CMS SignedData with CAdES-BES signed
 *    attributes (content-type, message-digest, signing-time, signing-certificate-v2).
 *
 * All encoding is PKI.js / asn1js; all cryptography is WebCrypto.
 */

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  commonName: '2.5.4.3',
};

const EC_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('WebCrypto is not available');
  return c.subtle;
}

const toAb = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function toBase64(b: ArrayBuffer | Uint8Array): string {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function pemToDer(pem: string): Uint8Array {
  return fromBase64(pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, ''));
}

/** A signing key pair whose private key cannot be exported. */
export async function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  return (await subtle().generateKey(EC_P256, false, ['sign', 'verify'])) as CryptoKeyPair;
}

/**
 * PKCS#10 CSR (base64 DER). The subject is a placeholder: the CA writes the
 * subject from the HR / ЄДЕБО profile and ignores anything the client puts here.
 */
export async function createCsr(keys: CryptoKeyPair): Promise<string> {
  const csr = new pkijs.CertificationRequest();
  csr.version = 0;
  csr.subject.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: OID.commonName, value: new asn1js.Utf8String({ value: 'PUET.Pulse' }) }));
  await csr.subjectPublicKeyInfo.importKey(keys.publicKey);
  await csr.sign(keys.privateKey, 'SHA-256');
  return toBase64(csr.toSchema().toBER(false));
}

/** SHA-256 of the document bytes (hex), e.g. to show or compare with the server's digest. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = new Uint8Array(await subtle().digest('SHA-256', toAb(data)));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Detached CAdES-BES signature over a document whose SHA-256 is given. Use it
 * when the client holds only the digest (e.g. a confidential, view-only file).
 * Returns base64 DER of CMS ContentInfo(SignedData) without encapsulated content.
 */
export async function signDigest(sha256: Uint8Array, privateKey: CryptoKey, certificate: string | Uint8Array, signingTime = new Date()): Promise<string> {
  if (sha256.length !== 32) throw new Error('A SHA-256 digest has 32 bytes');
  const certDer = typeof certificate === 'string' ? pemToDer(certificate) : certificate;
  const cert = pkijs.Certificate.fromBER(toAb(certDer));
  const certHash = new Uint8Array(await subtle().digest('SHA-256', toAb(certDer)));

  // SigningCertificateV2 ::= SEQUENCE { certs SEQUENCE OF ESSCertIDv2 }, ESSCertIDv2 with default SHA-256.
  const signingCertificateV2 = new asn1js.Sequence({
    value: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: toAb(certHash) })] })] })],
  });

  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
  });
  signerInfo.signedAttrs = new pkijs.SignedAndUnsignedAttributes({
    type: 0,
    attributes: [
      new pkijs.Attribute({ type: OID.contentType, values: [new asn1js.ObjectIdentifier({ value: OID.data })] }),
      new pkijs.Attribute({ type: OID.signingTime, values: [new asn1js.UTCTime({ valueDate: signingTime })] }),
      new pkijs.Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: toAb(sha256) })] }),
      new pkijs.Attribute({ type: OID.signingCertificateV2, values: [signingCertificateV2] }),
    ],
  });

  const signed = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    signerInfos: [signerInfo],
    certificates: [cert],
  });
  // With signed attributes present, PKI.js signs their DER encoding (which carries the digest).
  await signed.sign(privateKey, 0, 'SHA-256');
  const info = new pkijs.ContentInfo({ contentType: OID.signedData, content: signed.toSchema(true) });
  return toBase64(info.toSchema().toBER(false));
}

/** Detached CAdES-BES signature over the document bytes. */
export async function signDetached(data: Uint8Array, privateKey: CryptoKey, certificate: string | Uint8Array, signingTime = new Date()): Promise<string> {
  const digest = new Uint8Array(await subtle().digest('SHA-256', toAb(data)));
  return signDigest(digest, privateKey, certificate, signingTime);
}

/** Hex string to bytes, e.g. for the server's `servedSha256`. */
export function hexToBytes(hex: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new Error('Invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
