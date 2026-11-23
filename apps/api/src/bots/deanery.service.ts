import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@puet/database';
import type { Principal, Resource } from '@puet/policy-engine';
import { BotCode } from '@puet/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { SyncResult } from '../integrations/sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { BotInboxService } from './bot-inbox.service';
import type { DeaneryBatch, orderDocumentInput } from './bots.schemas';
import { OutboxService } from './outbox.service';

const TERMINAL = new Set(['ISSUED', 'REJECTED', 'CANCELLED']);

const requestDto = (r: {
  id: string;
  type: string;
  copies: number;
  purpose: string | null;
  status: string;
  deaneryNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: r.id,
  type: r.type,
  copies: r.copies,
  purpose: r.purpose,
  status: r.status,
  note: r.deaneryNote,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/**
 * «ЄДЕБО / Деканат». Students order certificates here; the deanery system receives each order
 * through the signed outbox and reports progress through the DEANERY webhook. Study plan (ІНП)
 * statuses arrive through the same webhook.
 */
@Injectable()
export class DeaneryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BotInboxService) private readonly inbox: BotInboxService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async order(principal: Principal, input: z.infer<typeof orderDocumentInput>) {
    const student = await this.prisma.user.findFirst({
      where: { id: principal.userId, tenantId: principal.tenantId, studentProfile: { isNot: null } },
      select: { edeboId: true },
    });
    if (!student) throw new ForbiddenException('Access denied');
    let row;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.studentDocumentRequest.create({
          data: { tenantId: principal.tenantId, studentId: principal.userId, type: input.type, copies: input.copies, purpose: input.purpose ?? null },
        });
        await this.outbox.enqueue(
          principal.tenantId,
          'DEANERY',
          'document.requested',
          { requestId: created.id, edeboId: student.edeboId, type: created.type, copies: created.copies, purpose: created.purpose },
          tx,
        );
        return created;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('You already have an open request for this certificate');
      }
      throw e;
    }
    await this.audit.record({ actorId: principal.userId, tenantId: principal.tenantId, action: 'deanery.document.order', resourceType: 'student_document', resourceId: row.id, outcome: 'SUCCESS', metadata: { type: row.type } });
    await this.inbox.post(principal.tenantId, [principal.userId], BotCode.DEANERY, {
      card: { kind: 'document_request', requestId: row.id, type: row.type, status: row.status },
    });
    return requestDto(row);
  }

  async mine(principal: Principal) {
    const rows = await this.prisma.studentDocumentRequest.findMany({
      where: { studentId: principal.userId, tenantId: principal.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map(requestDto);
  }

  async cancel(principal: Principal, resource: Resource) {
    const row = await this.prisma.studentDocumentRequest.findFirst({ where: { id: resource.id!, tenantId: resource.tenantId, studentId: principal.userId } });
    if (!row) throw new ForbiddenException('Access denied');
    if (row.status !== 'REQUESTED') throw new ConflictException('The deanery is already working on this request');
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.studentDocumentRequest.update({ where: { id: row.id }, data: { status: 'CANCELLED', closedAt: new Date() } });
      await this.outbox.enqueue(resource.tenantId, 'DEANERY', 'document.cancelled', { requestId: row.id }, tx);
      return u;
    });
    return requestDto(updated);
  }

  /** Study plans of the current semester (and the last two, for context). */
  async studyPlans(principal: Principal) {
    const rows = await this.prisma.individualStudyPlan.findMany({
      where: { studentId: principal.userId, tenantId: principal.tenantId },
      include: { semester: { select: { code: true, isCurrent: true, startsOn: true } } },
      orderBy: { semester: { startsOn: 'desc' } },
      take: 3,
    });
    return rows.map((r) => ({
      semester: r.semester.code,
      isCurrent: r.semester.isCurrent,
      status: r.status,
      credits: r.credits === null ? null : Number(r.credits),
      note: r.note,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /** DEANERY webhook. Each record stands alone; failures are reported by index, never with personal data. */
  async ingest(tenantId: string, batch: DeaneryBatch): Promise<SyncResult> {
    const result: SyncResult = { created: 0, updated: 0, offboarded: 0, errors: [] };
    for (const [index, d] of batch.documents.entries()) {
      try {
        const row = await this.prisma.studentDocumentRequest.findFirst({ where: { id: d.requestId, tenantId } });
        if (!row) throw new Error('request.not_found');
        if (row.status === d.status) continue;
        const updated = await this.prisma.studentDocumentRequest.update({
          where: { id: row.id },
          data: {
            status: d.status,
            ...(d.note !== undefined ? { deaneryNote: d.note } : {}),
            ...(d.externalRef !== undefined ? { externalRef: d.externalRef } : {}),
            ...(TERMINAL.has(d.status) ? { closedAt: new Date() } : {}),
          },
        });
        result.updated++;
        await this.inbox.post(tenantId, [row.studentId], BotCode.DEANERY, {
          card: { kind: 'document_request', requestId: row.id, type: row.type, status: updated.status, note: updated.deaneryNote },
        });
      } catch (err) {
        // The DB trigger refuses transitions outside the life cycle (e.g. ISSUED before READY).
        result.errors.push({ index, error: (err as Error).message === 'request.not_found' ? 'request.not_found' : 'document.transition_refused' });
      }
    }
    const base = batch.documents.length;
    for (const [i, p] of batch.studyPlans.entries()) {
      const index = base + i;
      try {
        const [student, semester] = await Promise.all([
          this.prisma.user.findFirst({ where: { tenantId, edeboId: p.edeboId }, select: { id: true } }),
          this.prisma.semester.findFirst({ where: { tenantId, code: p.semesterCode }, select: { id: true, code: true } }),
        ]);
        if (!student) throw new Error('student.not_found');
        if (!semester) throw new Error('semester.not_found');
        const key = { studentId_semesterId: { studentId: student.id, semesterId: semester.id } };
        const before = await this.prisma.individualStudyPlan.findUnique({ where: key, select: { status: true } });
        const data = { status: p.status, credits: p.credits ?? null, note: p.note ?? null };
        await this.prisma.individualStudyPlan.upsert({ where: key, create: { tenantId, studentId: student.id, semesterId: semester.id, ...data }, update: data });
        if (before) result.updated++;
        else result.created++;
        if (before?.status !== p.status) {
          await this.inbox.post(tenantId, [student.id], BotCode.DEANERY, {
            card: { kind: 'study_plan', semester: semester.code, status: p.status, credits: p.credits ?? null, note: p.note ?? null },
          });
        }
      } catch (err) {
        const msg = (err as Error).message;
        result.errors.push({ index, error: msg === 'student.not_found' || msg === 'semester.not_found' ? msg : 'study_plan.failed' });
      }
    }
    return result;
  }
}
