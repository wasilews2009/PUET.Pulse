import { z } from 'zod';
import { verifyDetachedCms, SignatureRejectedError } from './cms';
import { dnString, issuedBy, parseCertificate, serialHex, sha256Hex, toPem, type CaMaterial } from './x509';

export { SignatureRejectedError } from './cms';

export type ProviderKind = 'INTERNAL_PKI' | 'EXTERNAL_QES';

export interface SignerCertificate {
  pem: string;
  serialNumber: string;
  subjectDn: string;
  issuerDn: string;
  fingerprintSha256: string;
  notBefore: Date;
  notAfter: Date;
  /** Full name from the certificate, when the provider can tell it (used to bind QES certificates). */
  fullName?: string;
}

export interface VerifiedSignature {
  provider: ProviderKind;
  /** "CAdES-BES" (internal УЕП) or what the QES gateway validated, e.g. "CAdES-X-Long". */
  format: string;
  certificate: SignerCertificate;
  claimedSigningTime?: Date;
  tsp?: { time: Date; token?: Buffer };
  revocation: { source: 'internal' | 'ocsp'; checkedAt: Date };
}

/**
 * Every signature check goes through this interface (CLAUDE.md §1.3). The API
 * never parses ДСТУ 4145 / ДСТУ 7564 / CAdES-X Long itself.
 */
export interface SignatureProvider {
  readonly kind: ProviderKind;
  verify(signature: Buffer, data: Buffer, now: Date): Promise<VerifiedSignature>;
}

export const INTERNAL_SIGNATURE_PROVIDER = Symbol('INTERNAL_SIGNATURE_PROVIDER');
export const EXTERNAL_SIGNATURE_PROVIDER = Symbol('EXTERNAL_SIGNATURE_PROVIDER');

/**
 * УЕП of the internal university CA. Checks the CMS signature (PKI.js), that
 * the signer certificate was issued by our CA and is inside its validity period.
 * Certificate status (ACTIVE / REVOKED) and ownership are checked by the caller
 * against `user_certificates`, which is the CA's revocation database.
 */
export class InternalPkiProvider implements SignatureProvider {
  readonly kind = 'INTERNAL_PKI' as const;

  constructor(private readonly ca: () => Promise<CaMaterial>) {}

  async verify(signature: Buffer, data: Buffer, now: Date): Promise<VerifiedSignature> {
    const ca = await this.ca();
    const cms = await verifyDetachedCms(signature, data);
    const cert = cms.signerCertificate;
    if (!(await issuedBy(cert, ca))) throw new SignatureRejectedError('Certificate was not issued by the university CA');
    if (cert.notBefore.value > now || cert.notAfter.value < now) throw new SignatureRejectedError('Certificate is outside its validity period');
    return {
      provider: this.kind,
      format: 'CAdES-BES',
      certificate: {
        pem: toPem(cms.signerCertificateDer, 'CERTIFICATE'),
        serialNumber: serialHex(cert),
        subjectDn: dnString(cert.subject),
        issuerDn: dnString(cert.issuer),
        fingerprintSha256: sha256Hex(cms.signerCertificateDer),
        notBefore: cert.notBefore.value,
        notAfter: cert.notAfter.value,
      },
      ...(cms.claimedSigningTime ? { claimedSigningTime: cms.claimedSigningTime } : {}),
      revocation: { source: 'internal', checkedAt: now },
    };
  }
}

/** Contract of the on-premise QES gateway (IIT EUSignCP server / euscp wrapper). */
const gatewayResponse = z.object({
  valid: z.boolean(),
  format: z.string().max(64),
  qualified: z.boolean(),
  signer: z.object({
    certificate: z.string().max(20_000), // base64 DER
    fullName: z.string().max(300).optional(),
  }),
  ocsp: z.object({ status: z.enum(['good', 'revoked', 'unknown']), checkedAt: z.string().datetime() }),
  tsp: z.object({ valid: z.boolean(), time: z.string().datetime(), token: z.string().max(40_000).optional() }).nullable(),
  signingTime: z.string().datetime().optional(),
});

export interface QesGatewaySettings {
  url: string;
  token: string;
  /** How old the gateway's OCSP answer may be. */
  maxOcspAgeMs?: number;
  timeoutMs?: number;
}

/**
 * Adapter for a certified Ukrainian QES library (КЕП). The gateway does the
 * ДСТУ / CAdES-X Long validation, OCSP and TSP; this adapter only enforces
 * the outcome: a qualified, valid signature with a fresh "good" OCSP answer
 * and a valid TSP timestamp. Anything else is refused.
 */
export class ExternalQesAdapter implements SignatureProvider {
  readonly kind = 'EXTERNAL_QES' as const;

  constructor(
    private readonly settings: QesGatewaySettings | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured() {
    return this.settings !== null;
  }

  async verify(signature: Buffer, data: Buffer, now: Date): Promise<VerifiedSignature> {
    if (!this.settings) throw new QesUnavailableError('The QES gateway is not configured');
    let raw: unknown;
    try {
      const res = await this.fetchImpl(new URL('v1/verify-detached', this.settings.url.endsWith('/') ? this.settings.url : `${this.settings.url}/`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.settings.token}` },
        body: JSON.stringify({ signature: signature.toString('base64'), data: data.toString('base64') }),
        signal: AbortSignal.timeout(this.settings.timeoutMs ?? 30_000),
      });
      if (!res.ok) throw new Error(`gateway status ${res.status}`);
      raw = await res.json();
    } catch {
      throw new QesUnavailableError('The QES gateway is unavailable');
    }
    const parsed = gatewayResponse.safeParse(raw);
    if (!parsed.success) throw new QesUnavailableError('Unexpected QES gateway response');
    const r = parsed.data;

    if (!r.valid) throw new SignatureRejectedError('Qualified signature is invalid');
    if (!r.qualified) throw new SignatureRejectedError('The certificate is not qualified (КЕП)');
    if (r.ocsp.status !== 'good') throw new SignatureRejectedError('Certificate status is not good (OCSP)');
    const ocspAge = now.getTime() - new Date(r.ocsp.checkedAt).getTime();
    if (ocspAge > (this.settings.maxOcspAgeMs ?? 15 * 60_000) || ocspAge < -5 * 60_000) {
      throw new SignatureRejectedError('OCSP answer is not fresh');
    }
    if (!r.tsp || !r.tsp.valid) throw new SignatureRejectedError('A valid TSP timestamp is required');
    const tspTime = new Date(r.tsp.time);
    if (tspTime.getTime() > now.getTime() + 5 * 60_000) throw new SignatureRejectedError('TSP time is in the future');

    const der = Buffer.from(r.signer.certificate, 'base64');
    let cert;
    try {
      cert = parseCertificate(der);
    } catch {
      throw new QesUnavailableError('Unexpected QES gateway response');
    }
    return {
      provider: this.kind,
      format: r.format,
      certificate: {
        pem: toPem(der, 'CERTIFICATE'),
        serialNumber: serialHex(cert),
        subjectDn: dnString(cert.subject),
        issuerDn: dnString(cert.issuer),
        fingerprintSha256: sha256Hex(der),
        notBefore: cert.notBefore.value,
        notAfter: cert.notAfter.value,
        ...(r.signer.fullName ? { fullName: r.signer.fullName } : {}),
      },
      ...(r.signingTime ? { claimedSigningTime: new Date(r.signingTime) } : {}),
      tsp: { time: tspTime, ...(r.tsp.token ? { token: Buffer.from(r.tsp.token, 'base64') } : {}) },
      revocation: { source: 'ocsp', checkedAt: new Date(r.ocsp.checkedAt) },
    };
  }
}

export class QesUnavailableError extends Error {}

/** Compares a certificate name with a profile name: case, apostrophe variants and spacing do not matter. */
export function sameFullName(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .normalize('NFC')
      .toLocaleLowerCase('uk')
      .replace(/[’ʼ'`´]/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  return norm(a) === norm(b);
}
