import { Inject, Injectable } from '@nestjs/common';
import { BotCode } from '@puet/shared';
import type { SyncResult } from '../integrations/sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { BotInboxService } from './bot-inbox.service';
import type { EdoBatch } from './bots.schemas';
import { OutboxService } from './outbox.service';

interface RouteView {
  id: string;
  fileId: string;
  title: string;
  status: string;
  createdById: string;
  currentStepId: string | null;
  steps: { id: string; approverId: string }[];
}

/**
 * «ЕДО та Канцелярія». Tells approvers when an order reaches their step, tells the author how it
 * ended, hands approved orders to the ЕДО (signed outbox) and records the registration number the
 * ЕДО assigns (EDO webhook). Decisions themselves stay in the approval routes (Phase 4).
 */
@Injectable()
export class ChancelleryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BotInboxService) private readonly inbox: BotInboxService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async routeChanged(tenantId: string, route: RouteView): Promise<void> {
    const base = { routeId: route.id, fileId: route.fileId, title: route.title, status: route.status };
    if (route.status === 'PENDING') {
      const next = route.steps.find((s) => s.id === route.currentStepId);
      if (next) await this.inbox.post(tenantId, [next.approverId], BotCode.CHANCELLERY, { card: { kind: 'approval', ...base, event: 'your_turn' } });
      return;
    }
    if (route.status === 'APPROVED') {
      const file = await this.prisma.fileObject.findUnique({ where: { id: route.fileId }, select: { servedSha256: true } });
      await this.outbox.enqueue(tenantId, 'EDO', 'order.approved', {
        routeId: route.id,
        fileId: route.fileId,
        sha256: file?.servedSha256 ?? null,
        approvals: route.steps.length,
      });
      await this.inbox.post(tenantId, [route.createdById], BotCode.CHANCELLERY, { card: { kind: 'approval', ...base, event: 'approved' } });
      return;
    }
    if (route.status === 'REJECTED') {
      await this.inbox.post(tenantId, [route.createdById], BotCode.CHANCELLERY, { card: { kind: 'approval', ...base, event: 'rejected' } });
    }
  }

  /** EDO webhook: registration numbers. Only approved, not yet registered routes of this tenant. */
  async ingest(tenantId: string, batch: EdoBatch): Promise<SyncResult> {
    const result: SyncResult = { created: 0, updated: 0, offboarded: 0, errors: [] };
    for (const [index, r] of batch.registrations.entries()) {
      const route = await this.prisma.approvalRoute.findFirst({
        where: { id: r.routeId, tenantId },
        select: { id: true, fileId: true, title: true, status: true, createdById: true, registrationNo: true, steps: { select: { approverId: true } } },
      });
      if (!route) {
        result.errors.push({ index, error: 'route.not_found' });
        continue;
      }
      if (route.registrationNo === r.registrationNo) continue;
      if (route.status !== 'APPROVED' || route.registrationNo) {
        result.errors.push({ index, error: route.registrationNo ? 'route.already_registered' : 'route.not_approved' });
        continue;
      }
      await this.prisma.approvalRoute.update({ where: { id: route.id }, data: { registrationNo: r.registrationNo, registeredAt: new Date(r.registeredAt) } });
      result.updated++;
      await this.inbox.post(tenantId, [route.createdById, ...route.steps.map((s) => s.approverId)], BotCode.CHANCELLERY, {
        card: { kind: 'approval', routeId: route.id, fileId: route.fileId, title: route.title, status: route.status, event: 'registered', registrationNo: r.registrationNo },
      });
    }
    return result;
  }
}
