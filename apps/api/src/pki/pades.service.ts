import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@puet/database';
import type { Principal, Resource } from '@puet/policy-engine';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { contentDisposition } from '../files/file-types';
import { FilesService, type ServedFile } from '../files/files.service';
import { OBJECT_STORE, type ObjectStore } from '../files/object-store';
import { currentRecipients } from '../messaging/messaging.service';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime.bus';
import { embedCms, extractPades, PadesError, preparePades } from './pades';
import { INTERNAL_SIGNATURE_PROVIDER, SignatureRejectedError, type SignatureProvider } from './signature-provider';
import { toSignatureDto } from './signatures.service';
import { VerificationService } from './verification.service';

export const PADES_DRAFT_TTL_MS = 15 * 60_000;
export const PADES_FORMAT = 'PAdES-B-B';

export const padesCompleteInput = z
  .object({
    /** base64 DER of the CMS SignedData over the draft's byte ranges (no signing-time attribute needed). */
    signature: z.string().min(16).max(30_000).regex(/^[A-Za-z0-9+/=]+$/),
  })
  .strict();

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * PAdES signing with a visible QR stamp (internal УЕП). Step 1 stamps the
 * served PDF and returns the digest to sign; step 2 checks the client's CMS
 * through the SignatureProvider, embeds it and records the signature. Each
 * signer gets their own signed copy; the approval protocol lists them all.
 */
@Injectable()
export class PadesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
    @Inject(VerificationService) private readonly verification: VerificationService,
    @Inject(INTERNAL_SIGNATURE_PROVIDER) private readonly internal: SignatureProvider,
  ) {}

  async prepare(principal: Principal, file: Resource, now = new Date()) {
    const { file: f, body } = await this.files.servedBytes(file);
    if (f.mimeType !== 'application/pdf') throw new BadRequestException('Only PDF documents can carry a PAdES signature');
    // A stamped copy is meant to be downloaded and sent on; view-only documents are signed as detached CAdES.
    if (f.confidential) throw new BadRequestException('Confidential documents are signed with a detached signature');
    const cert = await this.prisma.userCertificate.findFirst({
      where: { userId: principal.userId, provider: 'INTERNAL_PKI', status: 'ACTIVE', notAfter: { gt: now } },
      orderBy: { notBefore: 'desc' },
    });
    if (!cert) throw new ConflictException('You have no active internal certificate');
    const signer = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
      select: { fullNameUk: true, staffProfile: { select: { position: true } }, studentProfile: { select: { id: true } } },
    });
    let verifyUrl: string | null = null;
    try {
      verifyUrl = this.verification.verifyUrl(f.id);
    } catch {
      verifyUrl = null; // verification not configured: the stamp has no QR code
    }
    let prepared;
    try {
      prepared = await preparePades(body, {
        signerName: signer.fullNameUk,
        signerTitle: signer.staffProfile?.position ?? (signer.studentProfile ? 'Студент' : null),
        certificateSerial: cert.serialNumber,
        signedAt: now,
        verifyUrl,
      });
    } catch (e) {
      if (e instanceof PadesError) throw new UnprocessableEntityException('This document cannot be stamped');
      throw e;
    }
    const id = randomUUID();
    const storageKey = `pades-draft/${f.tenantId}/${id}.pdf`;
    await this.store.put('attachments', storageKey, prepared.pdf, 'application/pdf');
    await this.prisma.padesDraft.create({
      data: {
        id,
        tenantId: f.tenantId,
        fileId: f.id,
        userId: principal.userId,
        certificateId: cert.id,
        baseSha256: sha256(body),
        digest: prepared.digest.toString('hex'),
        storageKey,
        createdAt: now,
        expiresAt: new Date(now.getTime() + PADES_DRAFT_TTL_MS),
      },
    });
    return { draftId: id, digest: prepared.digest.toString('hex'), digestAlgorithm: 'SHA-256', certificateId: cert.id, expiresAt: new Date(now.getTime() + PADES_DRAFT_TTL_MS).toISOString() };
  }

  async complete(principal: Principal, file: Resource, draftId: string, input: z.infer<typeof padesCompleteInput>, now = new Date()) {
    const draft = await this.prisma.padesDraft.findFirst({ where: { id: draftId, fileId: file.id!, tenantId: file.tenantId } });
    // IDOR: someone else's draft looks like a missing one.
    if (!draft || draft.userId !== principal.userId) throw new ForbiddenException('Access denied');
    const deny = async (reason: string, message: string) => {
      await this.audit.record({ actorId: principal.userId, tenantId: file.tenantId, action: 'document.sign', resourceType: 'file', resourceId: file.id!, outcome: 'DENIED', reason });
      throw new UnprocessableEntityException(message);
    };
    if (draft.expiresAt <= now) {
      await this.discard(draft);
      throw new ConflictException('The signing request expired, start again');
    }
    // The document must still be the one that was stamped.
    const { file: f, body } = await this.files.servedBytes(file);
    if (sha256(body) !== draft.baseSha256) return deny('signature.document_changed', 'The document changed');
    const prepared = await this.store.get('attachments', draft.storageKey);
    if (!prepared) throw new ConflictException('The signing request expired, start again');

    const cms = Buffer.from(input.signature, 'base64');
    let signed: Buffer;
    try {
      signed = embedCms(prepared, cms);
    } catch {
      return deny('signature.rejected', 'Signature rejected');
    }
    const extracted = extractPades(signed);
    if (sha256(extracted.content) !== draft.digest) return deny('signature.rejected', 'Signature rejected');
    let verified;
    try {
      verified = await this.internal.verify(extracted.cms, extracted.content, now);
    } catch (e) {
      if (e instanceof SignatureRejectedError) return deny('signature.rejected', 'Signature rejected');
      throw e;
    }
    const cert = await this.prisma.userCertificate.findUnique({ where: { fingerprintSha256: verified.certificate.fingerprintSha256 } });
    if (!cert || cert.id !== draft.certificateId || cert.userId !== principal.userId || cert.provider !== 'INTERNAL_PKI') {
      return deny('signature.foreign_certificate', 'Signature rejected');
    }
    if (cert.status !== 'ACTIVE' || cert.notAfter < now) return deny('signature.certificate_inactive', 'Your certificate is not active');

    const id = randomUUID();
    const signatureKey = `pades/${f.tenantId}/${id}.pdf`;
    await this.store.put('attachments', signatureKey, signed, 'application/pdf');
    const row = await this.prisma.documentSignature
      .create({
        data: {
          id,
          fileId: f.id,
          certificateId: cert.id,
          signerId: principal.userId,
          provider: 'INTERNAL_PKI',
          format: PADES_FORMAT,
          signatureKey,
          signedDigest: draft.baseSha256,
          digestAlgorithm: 'SHA-256',
          claimedSigningTime: draft.createdAt,
          revocationSource: verified.revocation.source,
          revocationCheckedAt: verified.revocation.checkedAt,
          signedCopySha256: sha256(signed),
        },
        include: { signer: { select: { fullNameUk: true } }, certificate: { select: { serialNumber: true } } },
      })
      .catch(async (e: unknown) => {
        await this.store.delete('attachments', signatureKey);
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('You have already signed this document');
        throw e;
      });
    await this.discard(draft);
    await this.audit.record({
      actorId: principal.userId,
      tenantId: file.tenantId,
      action: 'document.sign',
      resourceType: 'file',
      resourceId: f.id,
      outcome: 'SUCCESS',
      metadata: { signatureId: id, provider: 'INTERNAL_PKI', format: PADES_FORMAT, certificateSerial: cert.serialNumber },
    });
    if (f.channelId) await this.bus.emitToUsers(await currentRecipients(this.prisma, f.channelId), 'file.signed', { fileId: f.id, signatureId: id });
    return toSignatureDto(row);
  }

  /** The signed, stamped copy of one PAdES signature (downloads are authorized like the file's own). */
  async signedCopy(file: Resource, signatureId: string): Promise<ServedFile> {
    const row = await this.prisma.documentSignature.findFirst({
      where: { id: signatureId, fileId: file.id!, file: { tenantId: file.tenantId }, format: PADES_FORMAT },
      include: { file: { select: { fileName: true, confidential: true } } },
    });
    if (!row || row.file.confidential) throw new NotFoundException('Not found');
    const body = await this.store.get('attachments', row.signatureKey);
    if (!body || sha256(body) !== row.signedCopySha256) throw new ConflictException('The signed copy is not available');
    const name = row.file.fileName.replace(/\.pdf$/i, '') + ' (підписано).pdf';
    return { body, contentType: 'application/pdf', disposition: contentDisposition('attachment', name) };
  }

  private async discard(draft: { id: string; storageKey: string }) {
    await this.store.delete('attachments', draft.storageKey);
    await this.prisma.padesDraft.deleteMany({ where: { id: draft.id } });
  }

  async purgeExpiredDrafts(now = new Date()) {
    const rows = await this.prisma.padesDraft.findMany({ where: { expiresAt: { lte: now } }, select: { id: true, storageKey: true }, take: 500 });
    for (const r of rows) await this.discard(r);
    return rows.length;
  }
}
