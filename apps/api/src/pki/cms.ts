import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { ab, sha256Hex } from './x509';

const OID = {
  signedData: '1.2.840.113549.1.7.2',
  data: '1.2.840.113549.1.7.1',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  sha256: '2.16.840.1.101.3.4.2.1',
};

export class SignatureRejectedError extends Error {}

export interface CmsSignature {
  signerCertificate: pkijs.Certificate;
  signerCertificateDer: Buffer;
  claimedSigningTime?: Date;
}

/**
 * Verifies a detached CAdES-BES CMS signature over `data` with PKI.js:
 * exactly one signer, no encapsulated content, SHA-256 message digest that
 * matches the data, a valid signature by the embedded signer certificate, and a
 * signing-certificate-v2 attribute that binds that exact certificate.
 * Trust in the certificate itself (issuer, status, owner) is checked by the caller.
 */
export async function verifyDetachedCms(signatureDer: Uint8Array, data: Uint8Array): Promise<CmsSignature> {
  let signed: pkijs.SignedData;
  try {
    const info = pkijs.ContentInfo.fromBER(ab(signatureDer));
    if (info.contentType !== OID.signedData) throw new Error('not SignedData');
    signed = new pkijs.SignedData({ schema: info.content });
  } catch {
    throw new SignatureRejectedError('Malformed CMS signature');
  }
  if (signed.signerInfos.length !== 1) throw new SignatureRejectedError('Exactly one signer is required');
  if (signed.encapContentInfo.eContent) throw new SignatureRejectedError('A detached signature is required');
  const signer = signed.signerInfos[0]!;
  if (signer.digestAlgorithm.algorithmId !== OID.sha256) throw new SignatureRejectedError('SHA-256 is required');
  const attrs = signer.signedAttrs?.attributes ?? [];
  if (attrs.length === 0) throw new SignatureRejectedError('Signed attributes are required');

  let result: pkijs.SignedDataVerifyResult;
  try {
    result = (await signed.verify({ signer: 0, data: ab(data), checkChain: false, extendedMode: true })) as pkijs.SignedDataVerifyResult;
  } catch {
    throw new SignatureRejectedError('Signature is invalid');
  }
  if (!result.signatureVerified || !result.signerCertificate) throw new SignatureRejectedError('Signature is invalid');

  const cert = result.signerCertificate;
  const certDer = Buffer.from(cert.toSchema(true).toBER(false));

  // CAdES-BES: signing-certificate-v2 must name the signer certificate (SHA-256 of its DER).
  const scv2 = attrs.find((a) => a.type === OID.signingCertificateV2);
  const certHash = extractEssCertHash(scv2?.values[0]);
  if (!certHash || certHash !== sha256Hex(certDer)) throw new SignatureRejectedError('signing-certificate-v2 does not match the signer');

  const st = attrs.find((a) => a.type === OID.signingTime)?.values[0];
  const claimedSigningTime = st instanceof asn1js.UTCTime || st instanceof asn1js.GeneralizedTime ? st.toDate() : undefined;
  return { signerCertificate: cert, signerCertificateDer: certDer, ...(claimedSigningTime ? { claimedSigningTime } : {}) };
}

/** SigningCertificateV2 → first ESSCertIDv2 → certHash (hex), only for the default SHA-256 algorithm. */
function extractEssCertHash(value: unknown): string | null {
  try {
    const seq = value as asn1js.Sequence;
    const certs = seq.valueBlock.value[0] as asn1js.Sequence;
    const first = certs.valueBlock.value[0] as asn1js.Sequence;
    const items = first.valueBlock.value;
    // ESSCertIDv2 ::= SEQUENCE { hashAlgorithm AlgorithmIdentifier DEFAULT sha256, certHash, issuerSerial OPTIONAL }
    let idx = 0;
    if (items[0] instanceof asn1js.Sequence) {
      const alg = new pkijs.AlgorithmIdentifier({ schema: items[0] });
      if (alg.algorithmId !== OID.sha256) return null;
      idx = 1;
    }
    const hash = items[idx];
    if (!(hash instanceof asn1js.OctetString)) return null;
    return Buffer.from(hash.valueBlock.valueHexView).toString('hex');
  } catch {
    return null;
  }
}
