import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Principal, Resource } from '@puet/policy-engine';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';

const rect = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
}).strict();

/** JSON annotation layer over a PDF page. Coordinates are relative to the page (0..1). */
export const annotationInput = z
  .object({
    page: z.number().int().min(1).max(2000),
    visibility: z.enum(['PRIVATE', 'SHARED']).default('PRIVATE'),
    kind: z.enum(['highlight', 'underline', 'strike', 'comment', 'note']),
    rects: z.array(rect).min(1).max(64),
    text: z.string().max(4000).optional(),
    color: z.enum(['yellow', 'green', 'blue', 'red', 'navy', 'terracotta']).default('yellow'),
  })
  .strict();

export const annotationUpdate = annotationInput.partial().strict();

/** The file's comments, highlights and notes. The PDF bytes are never modified. */
@Injectable()
export class AnnotationsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private toDto(a: { id: string; authorId: string; page: number; visibility: string; payload: unknown; createdAt: Date; updatedAt: Date }) {
    return { id: a.id, authorId: a.authorId, page: a.page, visibility: a.visibility, ...(a.payload as object), createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString() };
  }

  async list(principal: Principal, file: Resource) {
    const rows = await this.prisma.pdfAnnotation.findMany({
      where: { fileId: file.id!, file: { tenantId: file.tenantId }, OR: [{ visibility: 'SHARED' }, { authorId: principal.userId }] },
      orderBy: [{ page: 'asc' }, { createdAt: 'asc' }],
      take: 2000,
    });
    return rows.map((r) => this.toDto(r));
  }

  async create(principal: Principal, file: Resource, input: z.infer<typeof annotationInput>) {
    const f = await this.prisma.fileObject.findFirstOrThrow({ where: { id: file.id!, tenantId: file.tenantId }, select: { pageCount: true, mimeType: true } });
    if (f.mimeType !== 'application/pdf' || !f.pageCount || input.page > f.pageCount) throw new NotFoundException('Page not found');
    const { page, visibility, ...payload } = input;
    const row = await this.prisma.pdfAnnotation.create({ data: { fileId: file.id!, authorId: principal.userId, page, visibility, payload } });
    return this.toDto(row);
  }

  private async own(principal: Principal, file: Resource, annotationId: string) {
    const a = await this.prisma.pdfAnnotation.findFirst({ where: { id: annotationId, fileId: file.id!, file: { tenantId: file.tenantId } } });
    // IDOR: someone else's annotation looks exactly like a missing one.
    if (!a || a.authorId !== principal.userId) throw new ForbiddenException('Access denied');
    return a;
  }

  async update(principal: Principal, file: Resource, annotationId: string, input: z.infer<typeof annotationUpdate>) {
    const a = await this.own(principal, file, annotationId);
    const { page, visibility, ...payload } = input;
    const row = await this.prisma.pdfAnnotation.update({
      where: { id: a.id },
      data: {
        ...(page ? { page } : {}),
        ...(visibility ? { visibility } : {}),
        payload: { ...(a.payload as object), ...payload },
      },
    });
    return this.toDto(row);
  }

  async remove(principal: Principal, file: Resource, annotationId: string) {
    const a = await this.own(principal, file, annotationId);
    await this.prisma.pdfAnnotation.delete({ where: { id: a.id } });
    return { deleted: true };
  }
}
