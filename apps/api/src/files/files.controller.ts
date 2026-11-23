import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { Action, ResourceType } from '@puet/shared';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/principal';
import { Authorize } from '../authz/authorize.decorator';
import { parse } from '../common/validation';
import { AnnotationsService, annotationInput, annotationUpdate, bookmarkInput } from './annotations';
import { FileForwardService, forwardInput } from './file-forward.service';
import { FilesService, readRawBody, type ServedFile } from './files.service';

const CHANNEL = { type: ResourceType.CHANNEL, idField: 'channelId' } as const;
const FILE = { type: ResourceType.FILE, idField: 'fileId' } as const;
const uuid = z.string().uuid();

/**
 * Parses a single `Range: bytes=a-b` header. Multiple ranges, suffix-less junk
 * and out-of-bounds starts are refused (null = serve whole, 'invalid' = 416).
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return 'invalid';
  return { start, end };
}

/** Headers for every served file: no caching, no sniffing, no active content even if opened directly. */
export function sendFile(res: Response, f: ServedFile, rangeHeader?: string) {
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', f.disposition);
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (!f.ranges) {
    res.setHeader('Content-Length', String(f.body.length));
    res.end(f.body);
    return;
  }
  res.setHeader('Accept-Ranges', 'bytes');
  const range = parseRange(rangeHeader, f.body.length);
  if (range === 'invalid') {
    res.status(416).setHeader('Content-Range', `bytes */${f.body.length}`);
    res.end();
    return;
  }
  if (!range) {
    res.setHeader('Content-Length', String(f.body.length));
    res.end(f.body);
    return;
  }
  res.status(206);
  res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${f.body.length}`);
  res.setHeader('Content-Length', String(range.end - range.start + 1));
  res.end(f.body.subarray(range.start, range.end + 1));
}

@Controller()
export class FilesController {
  constructor(
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(AnnotationsService) private readonly annotations: AnnotationsService,
    @Inject(FileForwardService) private readonly forwarding: FileForwardService,
  ) {}

  /** «Переслати»: copy a released file into another channel (the target is checked by the policy engine). */
  @Post('files/:fileId/forward')
  @Authorize(Action.FILE_DOWNLOAD, FILE)
  forward(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.forwarding.forward(req.principal!, req.authz!.resource, parse(forwardInput, body));
  }

  /**
   * Raw upload: body is the file (application/octet-stream), the UTF-8 name is
   * percent-encoded in `X-File-Name`. The type is sniffed from the bytes.
   */
  @Post('channels/:channelId/files')
  @Authorize(Action.FILE_UPLOAD, CHANNEL)
  async upload(@Req() req: AuthenticatedRequest, @Query('confidential') confidential?: string) {
    const raw = req.headers['x-file-name'];
    let name = 'file';
    if (typeof raw === 'string') {
      try {
        name = decodeURIComponent(raw);
      } catch {
        name = 'file';
      }
    }
    const body = await readRawBody(req as never, this.files.maxBytes);
    return this.files.upload(req.principal!, req.authz!.resource, body, name, confidential === 'true');
  }

  @Get('channels/:channelId/files')
  @Authorize(Action.MESSAGE_READ, CHANNEL)
  list(@Req() req: AuthenticatedRequest) {
    return this.files.listChannel(req.authz!.resource);
  }

  @Get('files/:fileId')
  @Authorize(Action.FILE_VIEW, FILE)
  get(@Req() req: AuthenticatedRequest) {
    return this.files.get(req.authz!.resource);
  }

  @Get('files/:fileId/view')
  @Authorize(Action.FILE_VIEW, FILE)
  async view(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    const f = await this.files.view(req.principal!, req.authz!.resource, { ip: req.ip ?? null, ranged: range !== undefined });
    sendFile(res, f, range);
  }

  @Get('files/:fileId/download')
  @Authorize(Action.FILE_DOWNLOAD, FILE)
  async download(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    sendFile(res, await this.files.download(req.authz!.resource));
  }

  @Get('files/:fileId/annotations')
  @Authorize(Action.FILE_VIEW, FILE)
  listAnnotations(@Req() req: AuthenticatedRequest) {
    return this.annotations.list(req.principal!, req.authz!.resource);
  }

  @Post('files/:fileId/annotations')
  @Authorize(Action.FILE_ANNOTATE, FILE)
  createAnnotation(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.annotations.create(req.principal!, req.authz!.resource, parse(annotationInput, body));
  }

  @Patch('files/:fileId/annotations/:annotationId')
  @Authorize(Action.FILE_ANNOTATE, FILE)
  updateAnnotation(@Req() req: AuthenticatedRequest, @Param('annotationId') id: string, @Body() body: unknown) {
    return this.annotations.update(req.principal!, req.authz!.resource, parse(uuid, id), parse(annotationUpdate, body));
  }

  /** Personal page bookmarks (only their owner sees them). */
  @Get('files/:fileId/bookmarks')
  @Authorize(Action.FILE_VIEW, FILE)
  listBookmarks(@Req() req: AuthenticatedRequest) {
    return this.annotations.listBookmarks(req.principal!, req.authz!.resource);
  }

  @Post('files/:fileId/bookmarks')
  @Authorize(Action.FILE_VIEW, FILE)
  addBookmark(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.annotations.addBookmark(req.principal!, req.authz!.resource, parse(bookmarkInput, body));
  }

  @Delete('files/:fileId/bookmarks/:bookmarkId')
  @Authorize(Action.FILE_VIEW, FILE)
  removeBookmark(@Req() req: AuthenticatedRequest, @Param('bookmarkId') id: string) {
    return this.annotations.removeBookmark(req.principal!, req.authz!.resource, parse(uuid, id));
  }

  @Delete('files/:fileId/annotations/:annotationId')
  @Authorize(Action.FILE_ANNOTATE, FILE)
  deleteAnnotation(@Req() req: AuthenticatedRequest, @Param('annotationId') id: string) {
    return this.annotations.remove(req.principal!, req.authz!.resource, parse(uuid, id));
  }
}
