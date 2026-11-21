import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@puet/database';
import type { Principal, Resource } from '@puet/policy-engine';
import { Action, ResourceType } from '@puet/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { PrincipalFactory } from '../auth/principal.factory';
import { UserTargetResolver } from '../authz/prisma-resolvers';
import { FilesService } from '../files/files.service';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime.bus';

export const createRouteInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    steps: z
      .array(z.object({ approverId: z.string().uuid(), requireSignature: z.boolean().default(true) }).strict())
      .min(1)
      .max(10),
  })
  .strict();

export const decisionInput = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    comment: z.string().trim().max(2000).optional(),
    signatureId: z.string().uuid().optional(),
  })
  .strict()
  .refine((d) => d.decision !== 'REJECT' || (d.comment?.length ?? 0) > 0, { message: 'A rejection needs a comment', path: ['comment'] });

const routeInclude = {
  steps: { orderBy: { position: 'asc' as const }, include: { approver: { select: { fullNameUk: true } } } },
  createdBy: { select: { fullNameUk: true } },
} satisfies Prisma.ApprovalRouteInclude;
type RouteRow = Prisma.ApprovalRouteGetPayload<{ include: typeof routeInclude }>;

export function toRouteDto(r: RouteRow) {
  const current = r.status === 'PENDING' ? r.steps.find((s) => s.status === 'PENDING') : undefined;
  return {
    id: r.id,
    fileId: r.fileId,
    title: r.title,
    status: r.status,
    createdById: r.createdById,
    createdByName: r.createdBy.fullNameUk,
    createdAt: r.createdAt.toISOString(),
    currentStepId: current?.id ?? null,
    steps: r.steps.map((s) => ({
      id: s.id,
      position: s.position,
      approverId: s.approverId,
      approverName: s.approver.fullNameUk,
      requireSignature: s.requireSignature,
      status: s.status,
      signatureId: s.signatureId,
      comment: s.comment,
      decidedAt: s.decidedAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Multi-step approval routes, e.g. Student → Head of Department → Institute
 * Director. Steps are decided strictly in order; approving a step that requires
 * it needs the approver's own electronic signature on the file.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(PrincipalFactory) private readonly principals: PrincipalFactory,
    @Inject(UserTargetResolver) private readonly users: UserTargetResolver,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
  ) {}

  /**
   * Every approver must be reachable by the creator (same DM rules as chats, so
   * a student cannot route a document to the Rectorate) and must be allowed to
   * approve documents at all. Failures are uniform 403s and audited.
   */
  private async assertApprovers(creator: Principal, file: Resource, approverIds: string[]) {
    for (const approverId of approverIds) {
      const target = await this.users.resolve(ResourceType.USER, approverId);
      const reach = target ? await this.policy.evaluate(creator, Action.DM_START, target, { now: new Date() }) : { allowed: false, reason: 'resource.not_found' };
      let reason = reach.allowed ? null : reach.reason;
      if (!reason) {
        const built = await this.principals.build(approverId, { mfaVerified: true });
        const can = built
          ? await this.policy.evaluate(built.principal, Action.DOCUMENT_APPROVE, { ...file, isMember: false, isApprover: true }, { now: new Date() })
          : { allowed: false, reason: 'resource.not_found' };
        reason = can.allowed ? null : `approver.${can.reason}`;
      }
      if (reason) {
        await this.audit.record({ actorId: creator.userId, tenantId: file.tenantId, action: Action.APPROVAL_ROUTE_CREATE, resourceType: 'user', resourceId: approverId, outcome: 'DENIED', reason });
        throw new ForbiddenException('Access denied');
      }
    }
  }

  async create(principal: Principal, file: Resource, input: z.infer<typeof createRouteInput>) {
    await this.files.servedBytes(file); // only released files enter a route
    const ids = input.steps.map((s) => s.approverId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Each approver appears once');
    if (ids.includes(principal.userId)) throw new BadRequestException('You cannot approve your own document');
    await this.assertApprovers(principal, file, ids);

    let route: RouteRow;
    try {
      route = await this.prisma.approvalRoute.create({
        data: {
          tenantId: file.tenantId,
          fileId: file.id!,
          title: input.title,
          createdById: principal.userId,
          steps: { create: input.steps.map((s, i) => ({ position: i + 1, approverId: s.approverId, requireSignature: s.requireSignature })) },
        },
        include: routeInclude,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('This document already has an open approval route');
      throw e;
    }
    await this.audit.record({ actorId: principal.userId, tenantId: file.tenantId, action: Action.APPROVAL_ROUTE_CREATE, resourceType: 'file', resourceId: file.id!, outcome: 'SUCCESS', metadata: { routeId: route.id, approvers: ids.length } });
    await this.bus.emitToUsers([ids[0]!], 'approval.requested', { fileId: file.id, routeId: route.id });
    return toRouteDto(route);
  }

  async list(file: Resource) {
    const rows = await this.prisma.approvalRoute.findMany({ where: { fileId: file.id!, tenantId: file.tenantId }, include: routeInclude, orderBy: { createdAt: 'desc' } });
    return rows.map(toRouteDto);
  }

  /** Steps waiting for the caller right now (their turn has come). */
  async inbox(principal: Principal) {
    const steps = await this.prisma.approvalStep.findMany({
      where: { approverId: principal.userId, status: 'PENDING', route: { status: 'PENDING', tenantId: principal.tenantId } },
      include: { route: { include: { ...routeInclude, file: { select: { id: true, fileName: true, channelId: true } } } } },
      take: 200,
    });
    return steps
      .filter((s) => s.route.steps.find((x) => x.status === 'PENDING')?.id === s.id)
      .map((s) => ({ ...toRouteDto(s.route), file: s.route.file }));
  }

  async decide(principal: Principal, file: Resource, routeId: string, stepId: string, input: z.infer<typeof decisionInput>, now = new Date()) {
    const result = await this.prisma.$transaction(async (tx) => {
      // Serialize decisions on one route.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM approval_routes WHERE id = ${routeId}::uuid AND file_id = ${file.id!}::uuid AND tenant_id = ${file.tenantId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new ForbiddenException('Access denied');
      const route = await tx.approvalRoute.findUniqueOrThrow({ where: { id: routeId }, include: routeInclude });
      const step = route.steps.find((s) => s.id === stepId);
      if (!step || step.approverId !== principal.userId) throw new ForbiddenException('Access denied');
      if (route.status !== 'PENDING') throw new ConflictException('The route is closed');
      const current = route.steps.find((s) => s.status === 'PENDING');
      if (current?.id !== step.id) throw new ConflictException('It is not your turn yet');

      if (input.decision === 'APPROVE') {
        let signatureId: string | null = null;
        if (step.requireSignature || input.signatureId) {
          if (!input.signatureId) throw new BadRequestException('This step requires your electronic signature');
          const sig = await tx.documentSignature.findFirst({ where: { id: input.signatureId, fileId: route.fileId, signerId: principal.userId } });
          if (!sig) throw new BadRequestException('This step requires your electronic signature');
          signatureId = sig.id;
        }
        await tx.approvalStep.update({ where: { id: step.id }, data: { status: 'APPROVED', decidedAt: now, signatureId, comment: input.comment ?? null } });
        const last = route.steps.every((s) => s.id === step.id || s.status === 'APPROVED');
        if (last) await tx.approvalRoute.update({ where: { id: route.id }, data: { status: 'APPROVED' } });
      } else {
        await tx.approvalStep.update({ where: { id: step.id }, data: { status: 'REJECTED', decidedAt: now, comment: input.comment ?? null } });
        await tx.approvalStep.updateMany({ where: { routeId: route.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
        await tx.approvalRoute.update({ where: { id: route.id }, data: { status: 'REJECTED' } });
      }
      return tx.approvalRoute.findUniqueOrThrow({ where: { id: route.id }, include: routeInclude });
    }).catch((e: unknown) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('This signature is already used for another step');
      throw e;
    });

    await this.audit.record({
      actorId: principal.userId,
      tenantId: file.tenantId,
      action: Action.DOCUMENT_APPROVE,
      resourceType: 'file',
      resourceId: file.id!,
      outcome: 'SUCCESS',
      metadata: { routeId, stepId, decision: input.decision, routeStatus: result.status },
    });
    const dto = toRouteDto(result);
    const next = dto.steps.find((s) => s.id === dto.currentStepId);
    await this.bus.emitToUsers([result.createdById, ...(next ? [next.approverId] : [])], 'approval.updated', { fileId: file.id, routeId, status: result.status });
    return dto;
  }

  async cancel(principal: Principal, file: Resource, routeId: string) {
    const route = await this.prisma.approvalRoute.findFirst({ where: { id: routeId, fileId: file.id!, tenantId: file.tenantId } });
    if (!route || route.createdById !== principal.userId) throw new ForbiddenException('Access denied');
    if (route.status !== 'PENDING') throw new ConflictException('The route is closed');
    await this.prisma.$transaction([
      this.prisma.approvalStep.updateMany({ where: { routeId, status: 'PENDING' }, data: { status: 'CANCELLED' } }),
      this.prisma.approvalRoute.update({ where: { id: routeId }, data: { status: 'CANCELLED' } }),
    ]);
    await this.audit.record({ actorId: principal.userId, tenantId: file.tenantId, action: 'approval.route.cancel', resourceType: 'file', resourceId: file.id!, outcome: 'SUCCESS', metadata: { routeId } });
    return toRouteDto(await this.prisma.approvalRoute.findUniqueOrThrow({ where: { id: routeId }, include: routeInclude }));
  }
}
