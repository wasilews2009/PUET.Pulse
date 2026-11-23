import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@puet/database';
import type { Principal, Resource } from '@puet/policy-engine';
import { Action, ResourceType } from '@puet/shared';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { ChannelScopedResolver } from '../authz/prisma-resolvers';
import { currentRecipients } from '../messaging/messaging.service';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime.bus';
import { fileStatus, FilesService, toFileDto } from './files.service';
import { OBJECT_STORE, type ObjectStore } from './object-store';

export const forwardInput = z.object({ channelId: z.string().uuid() }).strict();

/**
 * «Переслати»: a released file is copied into another channel. The policy
 * engine decides on the target channel with the source's facts attached:
 * confidential files never move, files of units that forbid it (Chancellery,
 * HR, Finance, Legal) stay inside that unit's channels, and nothing goes into
 * an end-to-end encrypted room. Only the served (scanned, sanitized) bytes are
 * copied, so the copy needs no new scan.
 */
@Injectable()
export class FileForwardService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(ChannelScopedResolver) private readonly resolver: ChannelScopedResolver,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
  ) {}

  async forward(principal: Principal, source: Resource, input: z.infer<typeof forwardInput>, now = new Date()) {
    const deny = async (reason: string) => {
      await this.audit.record({
        actorId: principal.userId,
        tenantId: source.tenantId,
        action: 'file.forward',
        resourceType: 'file',
        resourceId: source.id!,
        outcome: 'DENIED',
        reason,
        metadata: { channelId: input.channelId },
      });
      throw new ForbiddenException('Access denied');
    };
    const target = await this.resolver.resolve(ResourceType.CHANNEL, input.channelId, principal);
    if (!target) return deny('resource.not_found');
    if (target.id === undefined) return deny('resource.not_found');
    const decision = await this.policy.evaluate(
      principal,
      Action.FILE_FORWARD,
      {
        ...target,
        forwardSource: {
          tenantId: source.tenantId,
          ...(source.orgUnitId ? { orgUnitId: source.orgUnitId } : {}),
          restricted: source.forwardRestricted === true,
          confidential: source.confidential === true,
        },
      },
      { now },
    );
    if (!decision.allowed) return deny(decision.reason);

    // The exact bytes users of the source channel see (hash re-checked).
    const { file, body } = await this.files.servedBytes(source);
    if (fileStatus(file) !== 'READY' || !file.servedSha256) throw new ConflictException('The file is not available');
    const { outline } = await this.prisma.fileObject.findUniqueOrThrow({ where: { id: file.id }, select: { outline: true } });
    const id = randomUUID();
    const isPdf = file.mimeType === 'application/pdf';
    const key = isPdf ? `cdr/${target.tenantId}/${id}.pdf` : `orig/${target.tenantId}/${id}`;
    await this.store.put('attachments', key, body, file.mimeType);
    const row = await this.prisma.fileObject
      .create({
        data: {
          id,
          tenantId: target.tenantId,
          channelId: target.id,
          uploaderId: principal.userId,
          fileName: file.fileName,
          mimeType: file.mimeType,
          sizeBytes: BigInt(body.length),
          sha256: file.servedSha256,
          storageKey: key,
          ...(isPdf ? { sanitizedKey: key } : {}),
          scanStatus: 'CLEAN',
          scannedAt: now,
          cdrStatus: isPdf ? 'SANITIZED' : 'NOT_REQUIRED',
          servedSha256: file.servedSha256,
          servedSize: BigInt(body.length),
          pageCount: file.pageCount,
          ...(outline !== null ? { outline: outline as Prisma.InputJsonValue } : {}),
          confidential: false,
        },
      })
      .catch(async (e: unknown) => {
        await this.store.delete('attachments', key);
        throw e;
      });
    await this.audit.record({
      actorId: principal.userId,
      tenantId: target.tenantId,
      action: 'file.forward',
      resourceType: 'file',
      resourceId: id,
      outcome: 'SUCCESS',
      metadata: { sourceFileId: file.id, channelId: target.id, sha256: file.servedSha256 },
    });
    await this.bus.emitToUsers(await currentRecipients(this.prisma, target.id), 'file.ready', { fileId: id, channelId: target.id });
    return toFileDto(row);
  }
}
