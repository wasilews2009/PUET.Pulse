import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Prisma } from '@puet/database';
import type { Principal, Resource } from '@puet/policy-engine';
import { E2eeMode } from '@puet/shared';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { currentRecipients } from '../messaging/messaging.service';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime.bus';
import { contentDisposition, safeFileName, sniffType, VIEWABLE_TYPES } from './file-types';
import { MALWARE_SCANNER, type MalwareScanner } from './malware-scanner';
import { OBJECT_STORE, type ObjectStore } from './object-store';
import { PdfRejectedError, sanitizePdf, type OutlineEntry } from './pdf-sanitizer';
import { watermarkPdf } from './watermark';

const MAX_SCAN_ATTEMPTS = 5;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export interface FileDto {
  id: string;
  channelId: string | null;
  uploaderId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: 'PENDING' | 'READY' | 'REJECTED';
  confidential: boolean;
  viewable: boolean;
  pageCount: number | null;
  sha256: string | null;
  createdAt: string;
}

type FileRow = {
  id: string;
  tenantId: string;
  channelId: string | null;
  uploaderId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: bigint;
  storageKey: string;
  sanitizedKey: string | null;
  scanStatus: string;
  cdrStatus: string;
  confidential: boolean;
  servedSha256: string | null;
  pageCount: number | null;
  createdAt: Date;
};

export function fileStatus(f: Pick<FileRow, 'scanStatus' | 'cdrStatus' | 'servedSha256'>): FileDto['status'] {
  if (f.scanStatus === 'PENDING') return 'PENDING';
  return f.scanStatus === 'CLEAN' && f.servedSha256 ? 'READY' : 'REJECTED';
}

export function toFileDto(f: FileRow): FileDto {
  return {
    id: f.id,
    channelId: f.channelId,
    uploaderId: f.uploaderId,
    fileName: f.fileName,
    mimeType: f.mimeType,
    sizeBytes: Number(f.sizeBytes),
    status: fileStatus(f),
    confidential: f.confidential,
    viewable: VIEWABLE_TYPES.has(f.mimeType),
    pageCount: f.pageCount,
    sha256: f.servedSha256,
    createdAt: f.createdAt.toISOString(),
  };
}

export interface ServedFile {
  body: Buffer;
  contentType: string;
  disposition: string;
  /** Byte ranges may be served (PDF.js loads only the pages it shows). Never for watermarked copies. */
  ranges?: boolean;
}

/** Who is looking: the watermark of a confidential view names them, their id and their address. */
export interface ViewContext {
  ip: string | null;
  /** A byte-range request: may reuse the bytes verified by the viewer's first full read. */
  ranged?: boolean;
}

/**
 * Short-lived cache of verified served bytes, so a viewer loading a large PDF
 * page by page (HTTP range requests) does not re-read and re-hash the object
 * for every chunk. Bounded by size and age; holds only non-confidential copies.
 */
export class ServedBytesCache {
  private readonly entries = new Map<string, { body: Buffer; at: number }>();
  private total = 0;

  constructor(
    private readonly maxBytes = 128 * 1024 * 1024,
    private readonly ttlMs = 120_000,
  ) {}

  get(key: string, now = Date.now()): Buffer | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (now - e.at > this.ttlMs) {
      this.drop(key);
      return undefined;
    }
    return e.body;
  }

  set(key: string, body: Buffer, now = Date.now()) {
    if (body.length > this.maxBytes / 4) return;
    this.drop(key);
    this.entries.set(key, { body, at: now });
    this.total += body.length;
    for (const k of this.entries.keys()) {
      if (this.total <= this.maxBytes) break;
      this.drop(k);
    }
  }

  private drop(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    this.total -= e.body.length;
    this.entries.delete(key);
  }
}

/** Reads a raw request body with a hard size limit (uploads are application/octet-stream). */
export async function readRawBody(req: IncomingMessage & { body?: unknown }, maxBytes: number): Promise<Buffer> {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > maxBytes) throw new PayloadTooLargeException('File is too large');
    return req.body;
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes) throw new PayloadTooLargeException('File is too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new PayloadTooLargeException('File is too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Files: quarantine → ClamAV → (PDF) CDR → release. Only CLEAN files are ever
 * served, and a PDF only as its sanitized copy (CLAUDE.md §1.5, §1.6).
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly cache = new ServedBytesCache();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
  ) {}

  get maxBytes() {
    return this.config.files.maxBytes;
  }

  async upload(principal: Principal, channel: Resource, body: Buffer, rawName: string, confidential: boolean) {
    if (channel.e2eeMode === E2eeMode.MANDATORY) {
      // The server cannot scan or sanitize client-encrypted bytes; plaintext would break the E2EE promise.
      throw new BadRequestException('Attachments are not available in end-to-end encrypted channels yet');
    }
    if (body.length === 0) throw new BadRequestException('Empty file');
    if (body.length > this.maxBytes) throw new PayloadTooLargeException('File is too large');
    const mimeType = sniffType(body);
    if (!mimeType) throw new UnsupportedMediaTypeException('This file type is not allowed');
    if (confidential && mimeType !== 'application/pdf') throw new BadRequestException('Only PDF documents can be confidential');

    const id = randomUUID();
    const storageKey = `${channel.tenantId}/${id}`;
    await this.store.put('quarantine', storageKey, body, mimeType);
    const row = await this.prisma.fileObject.create({
      data: {
        id,
        tenantId: channel.tenantId,
        channelId: channel.id!,
        uploaderId: principal.userId,
        fileName: safeFileName(rawName),
        mimeType,
        sizeBytes: BigInt(body.length),
        sha256: sha256(body),
        storageKey,
        confidential,
        cdrStatus: mimeType === 'application/pdf' ? 'PENDING' : 'NOT_REQUIRED',
      },
    });
    await this.audit.record({
      actorId: principal.userId,
      tenantId: channel.tenantId,
      action: 'file.upload',
      resourceType: 'file',
      resourceId: id,
      outcome: 'SUCCESS',
      metadata: { channelId: channel.id, mimeType, sizeBytes: body.length, confidential },
    });
    if (this.config.files.scanInline) {
      void this.process(id).catch((e: unknown) => this.logger.warn(`file processing deferred: ${(e as Error).message}`));
    }
    return toFileDto(row);
  }

  /**
   * Scans a quarantined file and releases it. Safe to call concurrently: each
   * attempt is claimed by bumping `scan_attempts` with a compare-and-set.
   */
  async process(fileId: string, now = new Date()): Promise<'released' | 'rejected' | 'retry' | 'skipped'> {
    const file = await this.prisma.fileObject.findUnique({ where: { id: fileId } });
    if (!file || file.scanStatus !== 'PENDING') return 'skipped';
    const claimed = await this.prisma.fileObject.updateMany({
      where: { id: fileId, scanStatus: 'PENDING', scanAttempts: file.scanAttempts },
      data: { scanAttempts: { increment: 1 } },
    });
    if (claimed.count === 0) return 'skipped';

    const body = await this.store.get('quarantine', file.storageKey);
    if (!body || sha256(body) !== file.sha256) {
      await this.prisma.fileObject.update({ where: { id: fileId }, data: { scanStatus: 'FAILED', scannedAt: now } });
      return 'rejected';
    }

    let verdict;
    try {
      verdict = await this.scanner.scan(body);
    } catch {
      // Fail closed: the file stays in quarantine until the scanner answers.
      if (file.scanAttempts + 1 >= MAX_SCAN_ATTEMPTS) {
        await this.prisma.fileObject.update({ where: { id: fileId }, data: { scanStatus: 'FAILED', scannedAt: now } });
        await this.notify(file, 'file.rejected');
        return 'rejected';
      }
      return 'retry';
    }

    if (!verdict.clean) {
      await this.prisma.fileObject.update({
        where: { id: fileId },
        data: { scanStatus: 'INFECTED', malwareName: verdict.signature, scannedAt: now, cdrStatus: file.cdrStatus === 'PENDING' ? 'FAILED' : file.cdrStatus },
      });
      await this.store.delete('quarantine', file.storageKey);
      await this.audit.record({
        actorId: file.uploaderId,
        tenantId: file.tenantId,
        action: 'file.malware_detected',
        resourceType: 'file',
        resourceId: file.id,
        outcome: 'FAILURE',
        reason: 'malware',
        metadata: { signature: verdict.signature },
      });
      await this.notify(file, 'file.rejected');
      return 'rejected';
    }

    const originalKey = `orig/${file.tenantId}/${file.id}`;
    await this.store.put('attachments', originalKey, body, file.mimeType);

    if (file.mimeType === 'application/pdf') {
      try {
        const clean = await sanitizePdf(body);
        const sanitizedKey = `cdr/${file.tenantId}/${file.id}.pdf`;
        await this.store.put('attachments', sanitizedKey, clean.bytes, 'application/pdf');
        await this.prisma.fileObject.update({
          where: { id: fileId },
          data: {
            scanStatus: 'CLEAN',
            scannedAt: now,
            storageKey: originalKey,
            sanitizedKey,
            cdrStatus: 'SANITIZED',
            servedSha256: sha256(clean.bytes),
            servedSize: BigInt(clean.bytes.length),
            pageCount: clean.pageCount,
            outline: clean.outline.length > 0 ? (clean.outline as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          },
        });
      } catch (e) {
        if (!(e instanceof PdfRejectedError)) this.logger.warn('CDR failed unexpectedly');
        await this.prisma.fileObject.update({
          where: { id: fileId },
          data: { scanStatus: 'CLEAN', scannedAt: now, storageKey: originalKey, cdrStatus: 'FAILED' },
        });
        await this.store.delete('quarantine', file.storageKey);
        await this.notify(file, 'file.rejected');
        return 'rejected';
      }
    } else {
      await this.prisma.fileObject.update({
        where: { id: fileId },
        data: { scanStatus: 'CLEAN', scannedAt: now, storageKey: originalKey, servedSha256: file.sha256, servedSize: file.sizeBytes },
      });
    }
    await this.store.delete('quarantine', file.storageKey);
    await this.notify(file, 'file.ready');
    return 'released';
  }

  /** Quarantined files whose processing was interrupted or deferred (scanner down). */
  async processPending(now = new Date(), limit = 20) {
    const rows = await this.prisma.fileObject.findMany({
      where: { scanStatus: 'PENDING', scanAttempts: { lt: MAX_SCAN_ATTEMPTS }, createdAt: { lt: new Date(now.getTime() - 30_000) } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    for (const r of rows) await this.process(r.id, now);
    return rows.length;
  }

  private async notify(file: { id: string; channelId: string | null; uploaderId: string }, event: 'file.ready' | 'file.rejected') {
    const to = event === 'file.ready' && file.channelId ? await currentRecipients(this.prisma, file.channelId) : [file.uploaderId];
    await this.bus.emitToUsers(to, event, { fileId: file.id, channelId: file.channelId });
  }

  /** One file with its table of contents (read from the original outline during CDR). */
  async get(fileResource: Resource) {
    const f = await this.prisma.fileObject.findFirstOrThrow({ where: { id: fileResource.id!, tenantId: fileResource.tenantId } });
    return { ...toFileDto(f), outline: Array.isArray(f.outline) ? (f.outline as unknown as OutlineEntry[]) : [] };
  }

  async listChannel(channel: Resource, limit = 100) {
    const rows = await this.prisma.fileObject.findMany({
      where: { channelId: channel.id!, tenantId: channel.tenantId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toFileDto);
  }

  /** The exact bytes users view, download and sign: the sanitized copy for PDFs, otherwise the original. */
  async servedBytes(fileResource: Resource, opts: { cached?: boolean } = {}): Promise<{ file: FileRow; body: Buffer }> {
    const file = await this.prisma.fileObject.findFirstOrThrow({ where: { id: fileResource.id!, tenantId: fileResource.tenantId } });
    if (fileStatus(file) !== 'READY') throw new ConflictException('The file is not available');
    const key = file.mimeType === 'application/pdf' ? file.sanitizedKey : file.storageKey;
    if (!key) throw new ConflictException('The file is not available');
    const cacheKey = `${file.id}:${file.servedSha256}`;
    // Only ranged viewer reads may reuse bytes verified moments ago; signing,
    // verification and whole-file reads always re-hash what is in storage.
    const cached = file.confidential || !opts.cached ? undefined : this.cache.get(cacheKey);
    if (cached) return { file, body: cached };
    const body = await this.store.get('attachments', key);
    if (!body || sha256(body) !== file.servedSha256) throw new ConflictException('The file is not available');
    if (!file.confidential) this.cache.set(cacheKey, body);
    return { file, body };
  }

  /**
   * Inline rendering for the built-in viewer. Confidential PDFs get a per-viewer
   * watermark (name, corporate id, IP address, time) and are served whole; other
   * PDFs may be read in byte ranges so only the pages on screen are fetched.
   */
  async view(principal: Principal, fileResource: Resource, ctx: ViewContext = { ip: null }, now = new Date()): Promise<ServedFile> {
    const { file, body } = await this.servedBytes(fileResource, { cached: ctx.ranged === true });
    if (!VIEWABLE_TYPES.has(file.mimeType)) throw new UnsupportedMediaTypeException('This file can only be downloaded');
    let out = body;
    if (file.confidential) {
      const viewer = await this.prisma.user.findUniqueOrThrow({ where: { id: principal.userId }, select: { fullNameUk: true, corporateId: true } });
      out = await watermarkPdf(body, { fullName: viewer.fullNameUk, marker: viewer.corporateId, ip: ctx.ip }, now, 'ПУЕТ · Конфіденційно');
    }
    return {
      body: out,
      contentType: file.mimeType,
      disposition: contentDisposition('inline', file.fileName),
      ranges: !file.confidential && file.mimeType === 'application/pdf',
    };
  }

  async download(fileResource: Resource): Promise<ServedFile> {
    const { file, body } = await this.servedBytes(fileResource);
    // Defense in depth: the policy engine already denies downloads of confidential files.
    if (file.confidential) throw new ConflictException('The file is view-only');
    const contentType = file.mimeType.startsWith('text/') ? 'text/plain; charset=utf-8' : file.mimeType;
    return { body, contentType, disposition: contentDisposition('attachment', file.fileName) };
  }
}
