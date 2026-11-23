import {
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@puet/database';
import type { Principal, Resource } from '@puet/policy-engine';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { OBJECT_STORE, type ObjectStore } from '../files/object-store';
import { FilesService } from '../files/files.service';
import { currentRecipients } from '../messaging/messaging.service';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime.bus';
import {
  EXTERNAL_SIGNATURE_PROVIDER,
  INTERNAL_SIGNATURE_PROVIDER,
  QesUnavailableError,
  SignatureRejectedError,
  type ExternalQesAdapter,
  type SignatureProvider,
} from './signature-provider';

export const signInput = z
  .object({
    provider: z.enum(['INTERNAL_PKI', 'EXTERNAL_QES']),
    /** base64 DER of a detached CMS / CAdES signature over the served bytes. */
    signature: z.string().min(16).max(200_000).regex(/^[A-Za-z0-9+/=]+$/),
  })
  .strict();

export interface SignatureDto {
  id: string;
  fileId: string;
  signerId: string;
  signerName: string;
  provider: string;
  level: 'УЕП' | 'КЕП';
  format: string;
  certificateId: string;
  certificateSerial: string;
  signedDigest: string;
  claimedSigningTime: string | null;
  tspTimestamp: string | null;
  createdAt: string;
}

export const levelOf = (provider: string) => (provider === 'EXTERNAL_QES' ? 'КЕП' : 'УЕП') as 'УЕП' | 'КЕП';

/** Signing of released files. Every check goes through a SignatureProvider. */
@Injectable()
export class SignaturesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
    @Inject(INTERNAL_SIGNATURE_PROVIDER) private readonly internal: SignatureProvider,
    @Inject(EXTERNAL_SIGNATURE_PROVIDER) private readonly external: ExternalQesAdapter,
  ) {}

  /** What the client signs: the SHA-256 of the served bytes (the sanitized copy for PDFs). */
  async signingInfo(file: Resource) {
    const { file: f } = await this.files.servedBytes(file);
    return { fileId: f.id, sha256: f.servedSha256, digestAlgorithm: 'SHA-256', providers: { INTERNAL_PKI: true, EXTERNAL_QES: this.external.configured } };
  }

  async sign(principal: Principal, file: Resource, input: z.infer<typeof signInput>, now = new Date()): Promise<SignatureDto> {
    const { file: f, body } = await this.files.servedBytes(file);
    const signature = Buffer.from(input.signature, 'base64');
    const provider = input.provider === 'EXTERNAL_QES' ? this.external : this.internal;
    const deny = async (reason: string, message: string) => {
      await this.audit.record({ actorId: principal.userId, tenantId: file.tenantId, action: 'document.sign', resourceType: 'file', resourceId: f.id, outcome: 'DENIED', reason });
      throw new UnprocessableEntityException(message);
    };

    let verified;
    try {
      verified = await provider.verify(signature, body, now);
    } catch (e) {
      if (e instanceof QesUnavailableError) throw new ServiceUnavailableException('The QES gateway is unavailable');
      if (e instanceof SignatureRejectedError) return deny('signature.rejected', 'Signature rejected');
      throw e;
    }

    // The signer certificate must be one of the caller's own, active, of the same provider.
    const cert = await this.prisma.userCertificate.findUnique({ where: { fingerprintSha256: verified.certificate.fingerprintSha256 } });
    if (!cert || cert.userId !== principal.userId || cert.provider !== input.provider) {
      return deny('signature.foreign_certificate', input.provider === 'EXTERNAL_QES' ? 'Register your QES certificate first' : 'Signature rejected');
    }
    if (cert.status !== 'ACTIVE' || cert.notAfter < now) return deny('signature.certificate_inactive', 'Your certificate is not active');

    const id = randomUUID();
    const signatureKey = `sig/${f.tenantId}/${id}.p7s`;
    await this.store.put('attachments', signatureKey, signature, 'application/pkcs7-signature');
    const row = await this.prisma.documentSignature
      .create({
        data: {
          id,
          fileId: f.id,
          certificateId: cert.id,
          signerId: principal.userId,
          provider: input.provider,
          format: verified.format,
          signatureKey,
          signedDigest: createHash('sha256').update(body).digest('hex'),
          digestAlgorithm: 'SHA-256',
          claimedSigningTime: verified.claimedSigningTime ?? null,
          tspTimestamp: verified.tsp?.time ?? null,
          tspToken: verified.tsp?.token ? new Uint8Array(verified.tsp.token) : null,
          revocationSource: verified.revocation.source,
          revocationCheckedAt: verified.revocation.checkedAt,
        },
        include: { signer: { select: { fullNameUk: true } }, certificate: { select: { serialNumber: true } } },
      })
      .catch(async (e: unknown) => {
        await this.store.delete('attachments', signatureKey);
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('You have already signed this document');
        throw e;
      });
    await this.audit.record({
      actorId: principal.userId,
      tenantId: file.tenantId,
      action: 'document.sign',
      resourceType: 'file',
      resourceId: f.id,
      outcome: 'SUCCESS',
      metadata: { signatureId: id, provider: input.provider, certificateSerial: cert.serialNumber },
    });
    if (f.channelId) await this.bus.emitToUsers(await currentRecipients(this.prisma, f.channelId), 'file.signed', { fileId: f.id, signatureId: id });
    return toSignatureDto(row);
  }

  async list(file: Resource): Promise<SignatureDto[]> {
    const rows = await this.prisma.documentSignature.findMany({
      where: { fileId: file.id!, file: { tenantId: file.tenantId } },
      include: { signer: { select: { fullNameUk: true } }, certificate: { select: { serialNumber: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toSignatureDto);
  }
}

export function toSignatureDto(r: {
  id: string;
  fileId: string;
  signerId: string;
  provider: string;
  format: string;
  certificateId: string;
  signedDigest: string;
  claimedSigningTime: Date | null;
  tspTimestamp: Date | null;
  createdAt: Date;
  signer: { fullNameUk: string };
  certificate: { serialNumber: string };
}): SignatureDto {
  return {
    id: r.id,
    fileId: r.fileId,
    signerId: r.signerId,
    signerName: r.signer.fullNameUk,
    provider: r.provider,
    level: levelOf(r.provider),
    format: r.format,
    certificateId: r.certificateId,
    certificateSerial: r.certificate.serialNumber,
    signedDigest: r.signedDigest,
    claimedSigningTime: r.claimedSigningTime?.toISOString() ?? null,
    tspTimestamp: r.tspTimestamp?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}
