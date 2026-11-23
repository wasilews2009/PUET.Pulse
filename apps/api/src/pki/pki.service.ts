import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Principal, Resource } from '@puet/policy-engine';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  EXTERNAL_SIGNATURE_PROVIDER,
  QesUnavailableError,
  SignatureRejectedError,
  sameFullName,
  type ExternalQesAdapter,
} from './signature-provider';
import { CsrRejectedError, answerOcsp, buildCrl, issueCertificate, loadCa, parseCsr, type CaMaterial, type RevocationReasonName } from './x509';

export const CA_LOADER = Symbol('CA_LOADER');
export type CaLoader = () => Promise<CaMaterial>;

/** Reads the CA from files once. Unconfigured: every PKI call answers 503. */
export function fileCaLoader(config: AppConfig): CaLoader {
  let pending: Promise<CaMaterial> | null = null;
  return () => {
    if (!config.pki.caCertFile || !config.pki.caKeyFile) {
      return Promise.reject(new ServiceUnavailableException('The internal CA is not configured'));
    }
    pending ??= (async () => loadCa(await readFile(config.pki.caCertFile!, 'utf8'), await readFile(config.pki.caKeyFile!, 'utf8')))();
    pending.catch(() => (pending = null));
    return pending;
  };
}

const CHALLENGE_TTL_MS = 10 * 60_000;

export interface CertificateDto {
  id: string;
  provider: string;
  serialNumber: string;
  subjectDn: string;
  issuerDn: string;
  notBefore: string;
  notAfter: string;
  status: string;
  revokedAt: string | null;
  revocationReason: string | null;
  certificatePem: string;
}

const toDto = (c: {
  id: string;
  provider: string;
  serialNumber: string;
  subjectDn: string;
  issuerDn: string;
  notBefore: Date;
  notAfter: Date;
  status: string;
  revokedAt: Date | null;
  revocationReason: string | null;
  certificatePem: string;
}): CertificateDto => ({
  id: c.id,
  provider: c.provider,
  serialNumber: c.serialNumber,
  subjectDn: c.subjectDn,
  issuerDn: c.issuerDn,
  notBefore: c.notBefore.toISOString(),
  notAfter: c.notAfter.toISOString(),
  status: c.status,
  revokedAt: c.revokedAt?.toISOString() ?? null,
  revocationReason: c.revocationReason,
  certificatePem: c.certificatePem,
});

/**
 * Internal university CA (УЕП) and registration of qualified (КЕП) certificates.
 * The CA never sees a private key: it certifies the public key of a CSR and
 * writes the subject from the HR / ЄДЕБО profile.
 */
@Injectable()
export class PkiService {
  private crlCache: { der: Buffer; until: number } | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CA_LOADER) private readonly ca: CaLoader,
    @Inject(EXTERNAL_SIGNATURE_PROVIDER) private readonly qes: ExternalQesAdapter,
  ) {}

  get urls() {
    const base = this.config.pki.publicUrl;
    return { crl: `${base}/pki/crl`, ocsp: `${base}/pki/ocsp`, caIssuers: `${base}/pki/ca.crt` };
  }

  async caCertificate(): Promise<Buffer> {
    return (await this.ca()).certificateDer;
  }

  private async profile(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        staffProfile: { include: { departments: { include: { department: true } }, orgUnits: { include: { orgUnit: true } } } },
        studentProfile: { include: { academicGroup: true } },
      },
    });
    const staff = user.staffProfile;
    const primary = staff?.departments.find((d) => d.isPrimary) ?? staff?.departments[0];
    const unit = primary?.department.nameUk ?? staff?.orgUnits[0]?.orgUnit.nameUk ?? user.studentProfile?.academicGroup?.code;
    const title = staff?.position ?? (user.studentProfile?.educationLevel === 'LYCEUM' ? 'Учень' : user.studentProfile ? 'Студент' : 'Працівник');
    return { user, subject: { userId: user.id, fullName: user.fullNameUk, title, ...(unit ? { unit } : {}) } };
  }

  /** CSR → 1-year certificate. A previous active internal certificate is superseded. */
  async requestCertificate(principal: Principal, csrBase64: string, now = new Date()) {
    const ca = await this.ca();
    let parsed;
    try {
      parsed = await parseCsr(Buffer.from(csrBase64, 'base64'));
    } catch (e) {
      if (e instanceof CsrRejectedError) throw new BadRequestException(e.message);
      throw e;
    }
    if (await this.prisma.userCertificate.findUnique({ where: { publicKeySha256: parsed.publicKeySha256 }, select: { id: true } })) {
      throw new ConflictException('This key is already certified; generate a new key pair');
    }
    const { user, subject } = await this.profile(principal.userId);
    if (user.status !== 'ACTIVE') throw new ForbiddenException('Access denied');

    const notBefore = new Date(now.getTime() - 60_000);
    const notAfter = new Date(now.getTime() + this.config.pki.certDays * 86_400_000);
    const issued = await issueCertificate(ca, parsed.csr, subject, { notBefore, notAfter }, this.urls);

    const row = await this.prisma.$transaction(async (tx) => {
      await tx.userCertificate.updateMany({
        where: { userId: user.id, provider: 'INTERNAL_PKI', status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: now, revocationReason: 'SUPERSEDED' },
      });
      return tx.userCertificate.create({
        data: {
          userId: user.id,
          provider: 'INTERNAL_PKI',
          serialNumber: issued.serialNumber,
          subjectDn: issued.subjectDn,
          issuerDn: issued.issuerDn,
          certificatePem: issued.pem,
          fingerprintSha256: issued.fingerprintSha256,
          publicKeySha256: parsed.publicKeySha256,
          notBefore,
          notAfter,
        },
      });
    });
    this.crlCache = null;
    await this.audit.record({
      actorId: principal.userId,
      tenantId: principal.tenantId,
      action: 'certificate.issue',
      resourceType: 'certificate',
      resourceId: row.id,
      outcome: 'SUCCESS',
      metadata: { serialNumber: row.serialNumber, notAfter: notAfter.toISOString() },
    });
    return toDto(row);
  }

  async myCertificates(principal: Principal) {
    const rows = await this.prisma.userCertificate.findMany({ where: { userId: principal.userId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map(toDto);
  }

  async revokeOwn(principal: Principal, certificateId: string, reason: 'KEY_COMPROMISE' | 'UNSPECIFIED', now = new Date()) {
    const cert = await this.prisma.userCertificate.findFirst({ where: { id: certificateId, userId: principal.userId } });
    if (!cert) throw new ForbiddenException('Access denied');
    return this.revoke(principal, cert.id, reason, now, principal.tenantId);
  }

  /** Administrative revocation (CERTIFICATE_REVOKE, tenant-scoped). */
  async revokeInTenant(principal: Principal, tenant: Resource, certificateId: string, reason: RevocationReasonName, now = new Date()) {
    const cert = await this.prisma.userCertificate.findFirst({ where: { id: certificateId, user: { tenantId: tenant.tenantId } } });
    if (!cert) throw new ForbiddenException('Access denied');
    return this.revoke(principal, cert.id, reason, now, tenant.tenantId);
  }

  private async revoke(principal: Principal, id: string, reason: RevocationReasonName, now: Date, tenantId: string) {
    const updated = await this.prisma.userCertificate.updateMany({
      where: { id, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: now, revocationReason: reason },
    });
    if (updated.count === 0) throw new ConflictException('The certificate is not active');
    this.crlCache = null;
    await this.audit.record({ actorId: principal.userId, tenantId, action: 'certificate.revoke', resourceType: 'certificate', resourceId: id, outcome: 'SUCCESS', metadata: { reason } });
    return toDto(await this.prisma.userCertificate.findUniqueOrThrow({ where: { id } }));
  }

  async expireCertificates(now = new Date()) {
    const r = await this.prisma.userCertificate.updateMany({ where: { status: 'ACTIVE', notAfter: { lt: now } }, data: { status: 'EXPIRED' } });
    return r.count;
  }

  async crl(now = new Date()): Promise<Buffer> {
    if (this.crlCache && this.crlCache.until > now.getTime()) return this.crlCache.der;
    const ca = await this.ca();
    const revoked = await this.prisma.userCertificate.findMany({
      where: { provider: 'INTERNAL_PKI', status: 'REVOKED', notAfter: { gt: now } },
      select: { serialNumber: true, revokedAt: true, revocationReason: true },
      orderBy: { revokedAt: 'asc' },
    });
    const der = await buildCrl(
      ca,
      revoked.map((r) => ({ serialNumber: r.serialNumber, revokedAt: r.revokedAt!, reason: (r.revocationReason ?? 'UNSPECIFIED') as RevocationReasonName })),
      Math.floor(now.getTime() / 1000),
      now,
      new Date(now.getTime() + 24 * 3_600_000),
    );
    this.crlCache = { der, until: now.getTime() + 5 * 60_000 };
    return der;
  }

  async ocsp(requestDer: Buffer, now = new Date()): Promise<Buffer> {
    const ca = await this.ca();
    return answerOcsp(
      ca,
      requestDer,
      async (serialNumber) => {
        const c = await this.prisma.userCertificate.findFirst({ where: { serialNumber, provider: 'INTERNAL_PKI' } });
        if (!c) return { status: 'unknown' };
        if (c.status === 'REVOKED') return { status: 'revoked', revokedAt: c.revokedAt!, reason: (c.revocationReason ?? 'UNSPECIFIED') as RevocationReasonName };
        return { status: 'good' };
      },
      now,
    );
  }

  // ───────────── Qualified (КЕП) certificate binding ─────────────

  private challengeMac(userId: string, ts: number) {
    const secret = this.config.pki.verifyCodeSecret;
    if (!secret) throw new ServiceUnavailableException('QES binding is not configured');
    return createHmac('sha256', secret).update(`puet-qes-bind.v1:${userId}:${ts}`).digest('base64url');
  }

  /** A short-lived, stateless challenge that the user signs with their КЕП. */
  qesChallenge(principal: Principal, now = new Date()) {
    if (!this.qes.configured) throw new ServiceUnavailableException('The QES gateway is not configured');
    const ts = now.getTime();
    return { challenge: `puet-qes-bind.v1:${principal.userId}:${ts}:${this.challengeMac(principal.userId, ts)}`, expiresAt: new Date(ts + CHALLENGE_TTL_MS).toISOString() };
  }

  /**
   * Registers a qualified certificate after proof of possession: a valid КЕП
   * over our challenge, validated by the gateway (OCSP + TSP), whose holder
   * name equals the HR / ЄДЕБО profile name.
   */
  async bindQes(principal: Principal, challenge: string, signatureBase64: string, now = new Date()) {
    const parts = challenge.split(':');
    const [prefix, userId, tsRaw, mac] = parts;
    const ts = Number(tsRaw);
    const expected = userId && Number.isFinite(ts) ? this.challengeMac(userId, ts) : '';
    const ok =
      parts.length === 4 &&
      prefix === 'puet-qes-bind.v1' &&
      userId === principal.userId &&
      now.getTime() - ts <= CHALLENGE_TTL_MS &&
      ts <= now.getTime() + 60_000 &&
      !!mac &&
      mac.length === expected.length &&
      timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
    if (!ok) throw new BadRequestException('The challenge is invalid or expired');

    let verified;
    try {
      verified = await this.qes.verify(Buffer.from(signatureBase64, 'base64'), Buffer.from(challenge, 'utf8'), now);
    } catch (e) {
      if (e instanceof QesUnavailableError) throw new ServiceUnavailableException('The QES gateway is unavailable');
      if (e instanceof SignatureRejectedError) {
        await this.audit.record({ actorId: principal.userId, tenantId: principal.tenantId, action: 'certificate.qes_bind', outcome: 'DENIED', reason: 'signature.rejected' });
        throw new UnprocessableEntityException('Signature rejected');
      }
      throw e;
    }
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: principal.userId }, select: { fullNameUk: true } });
    if (!verified.certificate.fullName || !sameFullName(verified.certificate.fullName, user.fullNameUk)) {
      await this.audit.record({ actorId: principal.userId, tenantId: principal.tenantId, action: 'certificate.qes_bind', outcome: 'DENIED', reason: 'qes.name_mismatch' });
      throw new UnprocessableEntityException('The certificate holder does not match your profile');
    }
    const existing = await this.prisma.userCertificate.findUnique({ where: { fingerprintSha256: verified.certificate.fingerprintSha256 } });
    if (existing && existing.userId !== principal.userId) throw new ConflictException('This certificate is registered to another account');
    const row =
      existing ??
      (await this.prisma.userCertificate.create({
        data: {
          userId: principal.userId,
          provider: 'EXTERNAL_QES',
          serialNumber: `qes:${verified.certificate.fingerprintSha256}`,
          subjectDn: verified.certificate.subjectDn,
          issuerDn: verified.certificate.issuerDn,
          certificatePem: verified.certificate.pem,
          fingerprintSha256: verified.certificate.fingerprintSha256,
          notBefore: verified.certificate.notBefore,
          notAfter: verified.certificate.notAfter,
        },
      }));
    await this.audit.record({ actorId: principal.userId, tenantId: principal.tenantId, action: 'certificate.qes_bind', resourceType: 'certificate', resourceId: row.id, outcome: 'SUCCESS' });
    return toDto(row);
  }
}
