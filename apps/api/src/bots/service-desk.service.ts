import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@puet/database';
import type { Principal, Resource } from '@puet/policy-engine';
import { Action, BotCode, ResourceType, RoleCode } from '@puet/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { UserTargetResolver } from '../authz/prisma-resolvers';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { TICKET_UNIT } from './bot-codes';
import { BotInboxService } from './bot-inbox.service';
import type { createTicketInput, ticketHandleInput, ticketRequesterInput } from './bots.schemas';

const HANDLER_ROLES = [RoleCode.ADMIN_STAFF, RoleCode.FACILITIES_STAFF, RoleCode.DORM_COMMANDANT] as const;

const ticketSelect = {
  id: true,
  tenantId: true,
  number: true,
  requesterId: true,
  category: true,
  priority: true,
  title: true,
  description: true,
  location: true,
  orgUnitId: true,
  dormitoryId: true,
  roomLabel: true,
  status: true,
  assigneeId: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
  closedAt: true,
  requester: { select: { fullNameUk: true, fullNameEn: true } },
  assignee: { select: { fullNameUk: true } },
  orgUnit: { select: { nameUk: true, nameEn: true } },
  dormitory: { select: { number: true } },
} satisfies Prisma.ServiceTicketSelect;
type TicketRow = Prisma.ServiceTicketGetPayload<{ select: typeof ticketSelect }>;

function toDto(t: TicketRow, showRoom: boolean) {
  return {
    id: t.id,
    number: t.number,
    requesterId: t.requesterId,
    requesterName: t.requester.fullNameUk,
    category: t.category,
    priority: t.priority,
    title: t.title,
    description: t.description,
    location: t.location,
    unit: t.orgUnit ? { nameUk: t.orgUnit.nameUk, nameEn: t.orgUnit.nameEn } : null,
    dormitory: t.dormitory?.number ?? null,
    // Dormitory rooms are visible only to the resident and the commandant of that dormitory.
    room: showRoom ? t.roomLabel : null,
    status: t.status,
    assigneeName: t.assignee?.fullNameUk ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    resolvedAt: t.resolvedAt?.toISOString() ?? null,
    closedAt: t.closedAt?.toISOString() ?? null,
  };
}

/**
 * «Сервіс-деск АГР та ІТ». IT problems go to the Information Center, building problems to АГР,
 * dormitory repairs to the commandant of the requester's dormitory, who may forward them to АГР.
 * Handlers are resolved from current org-unit membership and commandant grants for every ticket.
 */
@Injectable()
export class ServiceDeskService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BotInboxService) private readonly inbox: BotInboxService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(UserTargetResolver) private readonly users: UserTargetResolver,
  ) {}

  private async unitId(tenantId: string, code: string): Promise<string> {
    const unit = await this.prisma.orgUnit.findFirst({ where: { tenantId, code, isActive: true }, select: { id: true } });
    if (!unit) throw new BadRequestException('This service is not set up for your institution');
    return unit.id;
  }

  async create(principal: Principal, input: z.infer<typeof createTicketInput>) {
    let route: { orgUnitId: string | null; dormitoryId: string | null; roomLabel: string | null };
    if (input.category === 'DORMITORY') {
      const profile = await this.prisma.studentProfile.findFirst({
        where: { userId: principal.userId, user: { tenantId: principal.tenantId } },
        select: { dormitoryRoom: { select: { number: true, dormitoryId: true } } },
      });
      if (!profile?.dormitoryRoom) throw new BadRequestException('Dormitory repairs are for dormitory residents');
      // Room and dormitory come from the profile, never from the request.
      route = { orgUnitId: null, dormitoryId: profile.dormitoryRoom.dormitoryId, roomLabel: profile.dormitoryRoom.number };
    } else {
      route = { orgUnitId: await this.unitId(principal.tenantId, TICKET_UNIT[input.category]), dormitoryId: null, roomLabel: null };
    }
    const ticket = await this.prisma.$transaction(async (tx) => {
      const t = await tx.serviceTicket.create({
        data: {
          tenantId: principal.tenantId,
          requesterId: principal.userId,
          category: input.category,
          priority: input.priority,
          title: input.title,
          description: input.description,
          location: input.category === 'DORMITORY' ? null : (input.location ?? null),
          ...route,
        },
        select: ticketSelect,
      });
      await tx.serviceTicketEvent.create({ data: { ticketId: t.id, actorId: principal.userId, kind: 'CREATED' } });
      return t;
    });
    await this.audit.record({ actorId: principal.userId, tenantId: principal.tenantId, action: 'ticket.create', resourceType: ResourceType.TICKET, resourceId: ticket.id, outcome: 'SUCCESS', metadata: { category: ticket.category } });
    await this.notify(ticket, 'created', principal.userId);
    return toDto(ticket, true);
  }

  async mine(principal: Principal) {
    const rows = await this.prisma.serviceTicket.findMany({
      where: { requesterId: principal.userId, tenantId: principal.tenantId },
      select: ticketSelect,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((t) => toDto(t, true));
  }

  /** Units and dormitories whose tickets this person handles (same predicate as TicketResolver + engine). */
  private async handledBy(principal: Principal) {
    const roles = principal.roles.filter((g) => !g.expiresAt || g.expiresAt > new Date());
    const canHandle = roles.some((g) => (HANDLER_ROLES as readonly string[]).includes(g.role));
    if (!canHandle) return { unitIds: [] as string[], dormitoryIds: [] as string[] };
    const units = await this.prisma.orgUnit.findMany({
      where: { id: { in: principal.orgUnitIds }, tenantId: principal.tenantId },
      select: { id: true, parentId: true, parent: { select: { parentId: true } } },
    });
    const unitIds = new Set<string>();
    for (const u of units) {
      unitIds.add(u.id);
      if (u.parentId) unitIds.add(u.parentId);
      if (u.parent?.parentId) unitIds.add(u.parent.parentId);
    }
    const dormitoryIds = roles
      .filter((g) => g.role === RoleCode.DORM_COMMANDANT && g.tenantId === principal.tenantId && g.scope?.dormitoryId)
      .map((g) => g.scope!.dormitoryId!);
    return { unitIds: [...unitIds], dormitoryIds };
  }

  async queue(principal: Principal, status?: string) {
    const { unitIds, dormitoryIds } = await this.handledBy(principal);
    if (unitIds.length === 0 && dormitoryIds.length === 0) return [];
    const statuses = status === 'closed' ? ['CLOSED', 'REJECTED'] : ['NEW', 'IN_PROGRESS', 'RESOLVED'];
    const rows = await this.prisma.serviceTicket.findMany({
      where: {
        tenantId: principal.tenantId,
        status: { in: statuses as never },
        OR: [{ orgUnitId: { in: unitIds } }, { dormitoryId: { in: dormitoryIds } }],
      },
      select: ticketSelect,
      orderBy: [{ createdAt: 'asc' }],
      take: 200,
    });
    return Promise.all(rows.map(async (t) => toDto(t, await this.mayShowRoom(principal, t))));
  }

  private async mayShowRoom(principal: Principal, t: { requesterId: string; roomLabel: string | null }): Promise<boolean> {
    if (!t.roomLabel) return false;
    if (t.requesterId === principal.userId) return true;
    const target = await this.users.resolve(ResourceType.USER, t.requesterId);
    if (!target) return false;
    const d = await this.policy.evaluate(principal, Action.USER_DORM_ROOM_READ, target, { now: new Date() });
    return d.allowed;
  }

  async get(principal: Principal, resource: Resource) {
    const t = await this.load(resource);
    const events = await this.prisma.serviceTicketEvent.findMany({
      where: { ticketId: t.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, kind: true, status: true, comment: true, createdAt: true, actorId: true, actor: { select: { fullNameUk: true } } },
    });
    return {
      ...toDto(t, await this.mayShowRoom(principal, t)),
      events: events.map((e) => ({
        id: e.id,
        kind: e.kind,
        status: e.status,
        comment: e.comment,
        createdAt: e.createdAt.toISOString(),
        byRequester: e.actorId === t.requesterId,
        actorName: e.actor.fullNameUk,
      })),
    };
  }

  private async load(resource: Resource): Promise<TicketRow> {
    const t = await this.prisma.serviceTicket.findFirst({ where: { id: resource.id!, tenantId: resource.tenantId }, select: ticketSelect });
    if (!t) throw new ForbiddenException('Access denied');
    return t;
  }

  async comment(principal: Principal, resource: Resource, comment: string) {
    const t = await this.load(resource);
    if (t.status === 'CLOSED' || t.status === 'REJECTED') throw new ConflictException('The ticket is closed');
    await this.prisma.serviceTicketEvent.create({ data: { ticketId: t.id, actorId: principal.userId, kind: 'COMMENT', comment } });
    await this.notify(t, 'comment', principal.userId);
    return this.get(principal, resource);
  }

  /** The requester confirms a resolved ticket (closes it) or reopens it. */
  async requesterAction(principal: Principal, resource: Resource, input: z.infer<typeof ticketRequesterInput>) {
    const t = await this.load(resource);
    if (t.requesterId !== principal.userId) throw new ForbiddenException('Access denied');
    if (t.status !== 'RESOLVED') throw new ConflictException('Only a resolved ticket can be confirmed or reopened');
    const now = new Date();
    const status = input.action === 'CONFIRM' ? 'CLOSED' : 'IN_PROGRESS';
    await this.prisma.$transaction(async (tx) => {
      await tx.serviceTicket.update({
        where: { id: t.id },
        data: status === 'CLOSED' ? { status, closedAt: now } : { status, resolvedAt: null },
      });
      await tx.serviceTicketEvent.create({ data: { ticketId: t.id, actorId: principal.userId, kind: 'STATUS', status } });
      if (input.comment) await tx.serviceTicketEvent.create({ data: { ticketId: t.id, actorId: principal.userId, kind: 'COMMENT', comment: input.comment } });
    });
    await this.notify({ ...t, status }, status === 'CLOSED' ? 'closed' : 'reopened', principal.userId);
    return this.get(principal, resource);
  }

  async handle(principal: Principal, resource: Resource, input: z.infer<typeof ticketHandleInput>) {
    const t = await this.load(resource);
    if (t.status === 'CLOSED' || t.status === 'REJECTED') throw new ConflictException('The ticket is closed');
    const now = new Date();
    const data: Prisma.ServiceTicketUpdateInput = {};
    let forwarded = false;
    if (input.forwardTo) {
      if (t.category !== 'DORMITORY') throw new BadRequestException('Only dormitory repairs are forwarded');
      data.category = 'FACILITIES';
      data.orgUnit = { connect: { id: await this.unitId(t.tenantId, TICKET_UNIT.FACILITIES) } };
      forwarded = true;
    }
    if (input.assignToMe) data.assignee = { connect: { id: principal.userId } };
    if (input.status) {
      data.status = input.status;
      if (input.status === 'RESOLVED') data.resolvedAt = now;
      if (input.status === 'REJECTED') data.closedAt = now;
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.serviceTicket.update({ where: { id: t.id }, data });
        if (forwarded) await tx.serviceTicketEvent.create({ data: { ticketId: t.id, actorId: principal.userId, kind: 'FORWARDED' } });
        if (input.assignToMe) await tx.serviceTicketEvent.create({ data: { ticketId: t.id, actorId: principal.userId, kind: 'ASSIGNED' } });
        if (input.status) await tx.serviceTicketEvent.create({ data: { ticketId: t.id, actorId: principal.userId, kind: 'STATUS', status: input.status } });
        if (input.comment) await tx.serviceTicketEvent.create({ data: { ticketId: t.id, actorId: principal.userId, kind: 'COMMENT', comment: input.comment } });
      });
    } catch (e) {
      // The DB trigger refuses transitions outside the life cycle.
      if (e instanceof Prisma.PrismaClientKnownRequestError || e instanceof Prisma.PrismaClientUnknownRequestError) {
        throw new ConflictException('This status change is not possible');
      }
      throw e;
    }
    const updated = await this.load(resource);
    await this.audit.record({ actorId: principal.userId, tenantId: t.tenantId, action: Action.TICKET_HANDLE, resourceType: ResourceType.TICKET, resourceId: t.id, outcome: 'SUCCESS', metadata: { status: updated.status, forwarded } });
    await this.notify(updated, forwarded ? 'forwarded' : input.status ? 'status' : 'assigned', principal.userId);
    return this.get(principal, resource);
  }

  /** Bot cards to the requester and the current handlers, except the person who acted. */
  private async notify(t: Pick<TicketRow, 'id' | 'tenantId' | 'number' | 'title' | 'status' | 'requesterId' | 'orgUnitId' | 'dormitoryId'>, event: string, actorId: string) {
    const handlers = await this.handlers(t);
    const to = [t.requesterId, ...handlers].filter((id) => id !== actorId);
    await this.inbox.post(t.tenantId, to, BotCode.SERVICE_DESK, {
      card: { kind: 'ticket', ticketId: t.id, number: t.number, title: t.title, status: t.status, event },
    });
  }

  private async handlers(t: { tenantId: string; orgUnitId: string | null; dormitoryId: string | null }): Promise<string[]> {
    const now = new Date();
    const activeRole = (roles: readonly string[], extra: Prisma.RoleAssignmentWhereInput = {}) => ({
      roleAssignments: { some: { role: { in: roles as never }, tenantId: t.tenantId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], ...extra } },
    });
    const ids = new Set<string>();
    if (t.orgUnitId) {
      const rows = await this.prisma.user.findMany({
        where: {
          tenantId: t.tenantId,
          status: 'ACTIVE',
          ...activeRole([RoleCode.ADMIN_STAFF, RoleCode.FACILITIES_STAFF]),
          staffProfile: {
            orgUnits: {
              some: {
                OR: [
                  { orgUnitId: t.orgUnitId },
                  { orgUnit: { parentId: t.orgUnitId } },
                  { orgUnit: { parent: { parentId: t.orgUnitId } } },
                ],
              },
            },
          },
        },
        select: { id: true },
        take: 200,
      });
      rows.forEach((r) => ids.add(r.id));
    }
    if (t.dormitoryId) {
      const rows = await this.prisma.user.findMany({
        where: { tenantId: t.tenantId, status: 'ACTIVE', ...activeRole([RoleCode.DORM_COMMANDANT], { dormitoryId: t.dormitoryId }) },
        select: { id: true },
        take: 20,
      });
      rows.forEach((r) => ids.add(r.id));
    }
    return [...ids];
  }
}
