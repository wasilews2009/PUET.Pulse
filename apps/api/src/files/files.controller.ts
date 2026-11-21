import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { Action, ResourceType } from '@puet/shared';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/principal';
import { Authorize } from '../authz/authorize.decorator';
import { parse } from '../common/validation';
import { AnnotationsService, annotationInput, annotationUpdate } from './annotations';
import { FilesService, readRawBody, type ServedFile } from './files.service';

const CHANNEL = { type: ResourceType.CHANNEL, idField: 'channelId' } as const;
const FILE = { type: ResourceType.FILE, idField: 'fileId' } as const;
const uuid = z.string().uuid();

/** Headers for every served file: no caching, no sniffing, no active content even if opened directly. */
export function sendFile(res: Response, f: ServedFile) {
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', f.disposition);
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.end(f.body);
}

@Controller()
export class FilesController {
  constructor(
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(AnnotationsService) private readonly annotations: AnnotationsService,
  ) {}

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
    sendFile(res, await this.files.view(req.principal!, req.authz!.resource));
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

  @Delete('files/:fileId/annotations/:annotationId')
  @Authorize(Action.FILE_ANNOTATE, FILE)
  deleteAnnotation(@Req() req: AuthenticatedRequest, @Param('annotationId') id: string) {
    return this.annotations.remove(req.principal!, req.authz!.resource, parse(uuid, id));
  }
}
