import { BadRequestException, ConflictException, Controller, Get, Inject, Injectable, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import type { Principal, Resource } from '@puet/policy-engine';
import { Action, E2eeMode, ResourceType } from '@puet/shared';
import type { Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/principal';
import { Authorize } from '../authz/authorize.decorator';
import { AuditService } from '../audit/audit.service';
import { parse } from '../common/validation';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService, readRawBody } from './files.service';
import { OBJECT_STORE, type ObjectStore } from './object-store';
import { sendFile } from './files.controller';

const CHANNEL = { type: ResourceType.CHANNEL, idField: 'channelId' } as const;
const uuid = z.string().uuid();
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** AES-GCM adds a 16-byte tag; anything shorter than a tag plus one byte is not a ciphertext. */
const MIN_CIPHERTEXT = 17;

/**
 * Attachments of end-to-end encrypted rooms (Phase 9). The client encrypts the
 * file with a fresh AES-256-GCM key (WebCrypto) and sends that key only inside
 * the Megolm-encrypted message. The server stores opaque ciphertext: it cannot
 * scan or sanitize it, so receiving clients check the type and render files
 * only in sandboxed viewers (CLAUDE.md, Phase 9 rules).
 */
@Injectable()
export class EncryptedBlobsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  get maxBytes() {
    // Ciphertext is the file plus the GCM tag.
    return this.files.maxBytes + 16;
  }

  async upload(principal: Principal, channel: Resource, body: Buffer, now = new Date()) {
    if (channel.e2eeMode !== E2eeMode.MANDATORY && channel.e2eeMode !== E2eeMode.OPTIONAL) {
      // Official channels get scanned, sanitized plaintext files instead.
      throw new BadRequestException('Encrypted attachments are for end-to-end encrypted channels only');
    }
    if (body.length < MIN_CIPHERTEXT) throw new BadRequestException('Not an encrypted attachment');
    const row = await this.prisma.channel.findFirstOrThrow({ where: { id: channel.id!, tenantId: channel.tenantId }, select: { messageTtlSeconds: true } });
    const id = randomUUID();
    const storageKey = `e2ee/${channel.tenantId}/${id}`;
    await this.store.put('attachments', storageKey, body, 'application/octet-stream');
    await this.prisma.encryptedBlob
      .create({
        data: {
          id,
          tenantId: channel.tenantId,
          channelId: channel.id!,
          uploaderId: principal.userId,
          sizeBytes: body.length,
          sha256: sha256(body),
          storageKey,
          createdAt: now,
          // Disappearing messages: the attachment lives a little longer than its message, then goes.
          ...(row.messageTtlSeconds ? { expiresAt: new Date(now.getTime() + (row.messageTtlSeconds + 3600) * 1000) } : {}),
        },
      })
      .catch(async (e: unknown) => {
        await this.store.delete('attachments', storageKey);
        throw e;
      });
    await this.audit.record({
      actorId: principal.userId,
      tenantId: channel.tenantId,
      action: 'file.upload',
      resourceType: 'encrypted_blob',
      resourceId: id,
      outcome: 'SUCCESS',
      metadata: { channelId: channel.id, sizeBytes: body.length },
    });
    return { blobId: id, sha256: sha256(body), sizeBytes: body.length };
  }

  async get(channel: Resource, blobId: string) {
    // IDOR: the blob must belong to the channel the caller was authorized for.
    const row = await this.prisma.encryptedBlob.findFirst({ where: { id: blobId, channelId: channel.id!, tenantId: channel.tenantId } });
    if (!row || (row.expiresAt && row.expiresAt <= new Date())) throw new NotFoundException('Not found');
    const body = await this.store.get('attachments', row.storageKey);
    if (!body || sha256(body) !== row.sha256) throw new ConflictException('The attachment is not available');
    return body;
  }

  async purgeExpired(now = new Date()) {
    const rows = await this.prisma.encryptedBlob.findMany({ where: { expiresAt: { lte: now } }, select: { id: true, storageKey: true }, take: 500 });
    for (const r of rows) {
      await this.store.delete('attachments', r.storageKey);
      await this.prisma.encryptedBlob.deleteMany({ where: { id: r.id } });
    }
    return rows.length;
  }
}

@Controller()
export class EncryptedBlobsController {
  constructor(@Inject(EncryptedBlobsService) private readonly blobs: EncryptedBlobsService) {}

  /** Raw ciphertext upload (application/octet-stream). An attachment is part of a message. */
  @Post('channels/:channelId/blobs')
  @Authorize(Action.MESSAGE_SEND, CHANNEL)
  async upload(@Req() req: AuthenticatedRequest) {
    const body = await readRawBody(req as never, this.blobs.maxBytes);
    return this.blobs.upload(req.principal!, req.authz!.resource, body);
  }

  @Get('channels/:channelId/blobs/:blobId')
  @Authorize(Action.MESSAGE_READ, CHANNEL)
  async get(@Req() req: AuthenticatedRequest, @Param('blobId') blobId: string, @Res() res: Response) {
    const body = await this.blobs.get(req.authz!.resource, parse(uuid, blobId));
    sendFile(res, { body, contentType: 'application/octet-stream', disposition: 'attachment; filename="encrypted.bin"' });
  }
}
