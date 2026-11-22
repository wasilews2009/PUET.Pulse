import { Inject, Injectable } from '@nestjs/common';
import type { Principal, Resource, TargetUserFacts } from '@puet/policy-engine';
import {
  ResourceType,
  type AccountStatus,
  type ChannelType,
  type E2eeMode,
  type MemberRole,
  type PrincipalKind,
  type RoleCode,
} from '@puet/shared';
import { BOT_OFFICE, BOT_SLUGS } from '../bots/bot-codes';
import { PrismaService } from '../prisma/prisma.service';
import type { ResourceResolver } from './resource-resolver';

const channelSelect = {
  id: true,
  tenantId: true,
  type: true,
  e2eeMode: true,
  confidential: true,
  archivedAt: true,
  instituteId: true,
  departmentId: true,
  orgUnitId: true,
  dormitoryId: true,
  courseOfferingId: true,
  createdById: true,
} as const;

type ChannelRow = {
  id: string;
  tenantId: string;
  type: string;
  e2eeMode: string;
  confidential: boolean;
  archivedAt: Date | null;
  instituteId: string | null;
  departmentId: string | null;
  orgUnitId: string | null;
  dormitoryId: string | null;
  courseOfferingId: string | null;
};

const opt = <K extends string, V>(key: K, value: V | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

/** Channels, messages, files: membership is computed for the calling principal. */
@Injectable()
export class ChannelScopedResolver implements ResourceResolver {
  readonly types = [ResourceType.CHANNEL, ResourceType.MESSAGE, ResourceType.FILE, ResourceType.VOTE, ResourceType.CALL] as const;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async resolve(type: ResourceType, id: string | undefined, principal: Principal): Promise<Resource | null> {
    if (!id) return null;
    let channel: ChannelRow | null = null;
    let ownerId: string | undefined;
    let confidential = false;

    if (type === ResourceType.CHANNEL) {
      channel = await this.prisma.channel.findUnique({ where: { id }, select: channelSelect });
    } else if (type === ResourceType.MESSAGE) {
      const msg = await this.prisma.message.findUnique({
        where: { id },
        select: { senderId: true, deletedAt: true, channel: { select: channelSelect } },
      });
      if (!msg || msg.deletedAt) return null;
      channel = msg.channel;
      ownerId = msg.senderId;
    } else if (type === ResourceType.CALL) {
      const call = await this.prisma.call.findUnique({
        where: { id },
        select: {
          tenantId: true,
          startedById: true,
          slot: { select: { id: true, tenantId: true, hostId: true, status: true } },
          message: { select: { deletedAt: true } },
          channel: { select: channelSelect },
        },
      });
      if (!call) return null;
      if (call.slot) {
        // Consultation room: the host and the students holding a live booking.
        if (call.slot.tenantId !== call.tenantId) return null;
        const booked = await this.prisma.consultationBooking.count({
          where: { slotId: call.slot.id, studentId: principal.userId, status: 'BOOKED' },
        });
        const isHost = call.slot.hostId === principal.userId;
        // A cancelled slot has no room for anybody.
        const member = call.slot.status === 'ACTIVE' && (isHost || booked > 0);
        return { type, id, tenantId: call.tenantId, ownerId: call.slot.hostId, isMember: member };
      }
      if (!call.channel || call.channel.tenantId !== call.tenantId || call.message?.deletedAt) return null;
      channel = call.channel;
      ownerId = call.startedById;
    } else if (type === ResourceType.VOTE) {
      const poll = await this.prisma.poll.findUnique({
        where: { id },
        select: { tenantId: true, createdById: true, message: { select: { deletedAt: true } }, channel: { select: channelSelect } },
      });
      // A poll whose message was deleted is gone for everybody; tenant must match its channel.
      if (!poll || poll.message.deletedAt || poll.channel.tenantId !== poll.tenantId) return null;
      channel = poll.channel;
      ownerId = poll.createdById;
    } else {
      const file = await this.prisma.fileObject.findUnique({
        where: { id },
        select: { tenantId: true, uploaderId: true, confidential: true, channel: { select: channelSelect } },
      });
      if (!file || !file.channel || file.channel.tenantId !== file.tenantId) return null;
      channel = file.channel;
      ownerId = file.uploaderId;
      confidential = file.confidential;
    }
    if (!channel) return null;

    const membership = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId: channel.id, userId: principal.userId } },
      select: { role: true, expiresAt: true },
    });
    const activeMember = !!membership && (!membership.expiresAt || membership.expiresAt > new Date());
    // Approvers named on a live or decided route of this file may read and sign it (policy engine decides).
    const isApprover =
      type === ResourceType.FILE &&
      (await this.prisma.approvalStep.count({
        where: { approverId: principal.userId, route: { fileId: id, status: { not: 'CANCELLED' } } },
      })) > 0;

    return {
      type,
      id,
      tenantId: channel.tenantId,
      channelType: channel.type as ChannelType,
      e2eeMode: channel.e2eeMode as E2eeMode,
      confidential: channel.confidential || confidential,
      archived: channel.archivedAt !== null,
      isMember: activeMember,
      ...(isApprover ? { isApprover: true } : {}),
      ...(activeMember ? { memberRole: membership!.role as MemberRole } : {}),
      ...opt('ownerId', ownerId),
      ...opt('instituteId', channel.instituteId),
      ...opt('departmentId', channel.departmentId),
      ...opt('orgUnitId', channel.orgUnitId),
      ...opt('dormitoryId', channel.dormitoryId),
      ...opt('courseOfferingId', channel.courseOfferingId),
    };
  }
}

/**
 * A consultation slot. The host is the owner; whether the caller holds a live booking is
 * computed here; the host's facts let the policy engine apply the DM rules to booking.
 */
@Injectable()
export class ConsultationResolver implements ResourceResolver {
  readonly types = [ResourceType.CONSULTATION] as const;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async resolve(type: ResourceType, id: string | undefined, principal: Principal): Promise<Resource | null> {
    if (!id) return null;
    const slot = await this.prisma.consultationSlot.findUnique({
      where: { id },
      select: { tenantId: true, hostId: true, courseOfferingId: true },
    });
    if (!slot) return null;
    const host = await loadTargetFacts(this.prisma, slot.hostId);
    if (!host || host.tenantId !== slot.tenantId) return null;
    const booked = await this.prisma.consultationBooking.count({
      where: { slotId: id, studentId: principal.userId, status: 'BOOKED' },
    });
    return {
      type,
      id,
      tenantId: slot.tenantId,
      ownerId: slot.hostId,
      target: host,
      ...(booked > 0 ? { isBooked: true } : {}),
      ...opt('courseOfferingId', slot.courseOfferingId),
    };
  }
}

/** A user as the target of DM / profile / phone / dorm-room actions. */
@Injectable()
export class UserTargetResolver implements ResourceResolver {
  readonly types = [ResourceType.USER] as const;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async resolve(_type: ResourceType, id: string | undefined): Promise<Resource | null> {
    if (!id) return null;
    const target = await loadTargetFacts(this.prisma, id);
    return target ? { type: ResourceType.USER, id, tenantId: target.tenantId, target } : null;
  }
}

/**
 * Tenant-level resources. Without an id they resolve to the caller's own tenant;
 * with an id (e.g. `/admin/tenants/:tenantId/...`) the tenant must exist, and the
 * policy engine then decides whether the caller's grants cover it.
 */
@Injectable()
export class TenantResourceResolver implements ResourceResolver {
  readonly types = [
    ResourceType.DIRECTORY,
    ResourceType.STRUCTURE,
    ResourceType.ROLE,
    ResourceType.POLICY,
    ResourceType.AUDIT,
    ResourceType.CERTIFICATE,
    ResourceType.SESSION,
    ResourceType.INTEGRATION,
  ] as const;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async resolve(type: ResourceType, id: string | undefined, principal: Principal): Promise<Resource | null> {
    if (!id) return { type, tenantId: principal.tenantId };
    const tenant = await this.prisma.tenant.findUnique({ where: { id }, select: { id: true } });
    return tenant ? { type, id, tenantId: tenant.id } : null;
  }
}

export async function loadTargetFacts(prisma: PrismaService, userId: string): Promise<TargetUserFacts | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      tenantId: true,
      kind: true,
      status: true,
      isMinor: true,
      roleAssignments: { select: { role: true, expiresAt: true } },
      studentProfile: {
        select: {
          instituteId: true,
          academicGroupId: true,
          dormitoryRoom: { select: { dormitoryId: true } },
        },
      },
      staffProfile: { select: { id: true } },
    },
  });
  if (!user) return null;

  const now = new Date();
  const activeCourseOfferingIds = await currentCourseOfferingIds(
    prisma,
    user.studentProfile?.academicGroupId ?? null,
    user.staffProfile?.id ?? null,
  );

  return {
    userId: user.id,
    tenantId: user.tenantId,
    kind: user.kind as PrincipalKind,
    status: user.status as AccountStatus,
    isMinor: user.isMinor,
    roles: user.roleAssignments
      .filter((r) => !r.expiresAt || r.expiresAt > now)
      .map((r) => r.role as RoleCode),
    instituteIds: user.studentProfile?.instituteId ? [user.studentProfile.instituteId] : [],
    academicGroupIds: user.studentProfile?.academicGroupId ? [user.studentProfile.academicGroupId] : [],
    ...opt('dormitoryId', user.studentProfile?.dormitoryRoom?.dormitoryId),
    activeCourseOfferingIds,
  };
}

/** Course offerings of the current semester, taught (staff) or enrolled via group (student). */
export async function currentCourseOfferingIds(
  prisma: PrismaService,
  academicGroupId: string | null,
  staffProfileId: string | null,
): Promise<string[]> {
  if (!academicGroupId && !staffProfileId) return [];
  const rows = await prisma.courseOffering.findMany({
    where: {
      semester: { isCurrent: true },
      OR: [
        ...(academicGroupId ? [{ groups: { some: { academicGroupId } } }] : []),
        ...(staffProfileId ? [{ lecturers: { some: { staffProfileId } } }] : []),
      ],
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** The caller's own account. Always owned by the caller; there is no id to tamper with. */
@Injectable()
export class SelfResolver implements ResourceResolver {
  readonly types = [ResourceType.SELF] as const;

  async resolve(type: ResourceType, _id: string | undefined, principal: Principal): Promise<Resource | null> {
    return { type, tenantId: principal.tenantId, ownerId: principal.userId };
  }
}

/** A registered E2EE device. Revoked devices do not resolve. */
@Injectable()
export class DeviceResolver implements ResourceResolver {
  readonly types = [ResourceType.DEVICE] as const;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async resolve(type: ResourceType, id: string | undefined): Promise<Resource | null> {
    if (!id) return null;
    const device = await this.prisma.device.findUnique({
      where: { id },
      select: { userId: true, revokedAt: true, user: { select: { tenantId: true } } },
    });
    if (!device || device.revokedAt) return null;
    return { type, id, tenantId: device.user.tenantId, ownerId: device.userId };
  }
}

/**
 * A corporate bot, addressed by slug (the guard accepts only known slugs). Its tenant is the caller's;
 * the bot office's org unit lets the policy engine check who maintains it (admissions rules).
 */
@Injectable()
export class BotResolver implements ResourceResolver {
  readonly types = [ResourceType.BOT] as const;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async resolve(type: ResourceType, id: string | undefined, principal: Principal): Promise<Resource | null> {
    const code = id ? BOT_SLUGS[id] : undefined;
    if (!code) return null;
    const office = await this.prisma.orgUnit.findFirst({
      where: { tenantId: principal.tenantId, code: BOT_OFFICE[code], isActive: true },
      select: { id: true },
    });
    return { type, id, tenantId: principal.tenantId, botCode: code, ...opt('orgUnitId', office?.id) };
  }
}

/**
 * A service desk ticket. The requester is the owner. `isHandler` is true when the caller works in
 * the unit the ticket is routed to or one of its sub-units (АГР → building operations, heat & power).
 */
@Injectable()
export class TicketResolver implements ResourceResolver {
  readonly types = [ResourceType.TICKET] as const;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async resolve(type: ResourceType, id: string | undefined, principal: Principal): Promise<Resource | null> {
    if (!id) return null;
    const ticket = await this.prisma.serviceTicket.findUnique({
      where: { id },
      select: { tenantId: true, requesterId: true, orgUnitId: true, dormitoryId: true },
    });
    if (!ticket) return null;
    let isHandler = false;
    if (ticket.orgUnitId && ticket.tenantId === principal.tenantId && principal.orgUnitIds.length > 0) {
      const units = await this.prisma.orgUnit.findMany({
        where: { id: { in: principal.orgUnitIds }, tenantId: ticket.tenantId },
        select: { id: true, parentId: true, parent: { select: { parentId: true } } },
      });
      isHandler = units.some(
        (u) => u.id === ticket.orgUnitId || u.parentId === ticket.orgUnitId || u.parent?.parentId === ticket.orgUnitId,
      );
    }
    return {
      type,
      id,
      tenantId: ticket.tenantId,
      ownerId: ticket.requesterId,
      isHandler,
      ...opt('orgUnitId', ticket.orgUnitId),
      ...opt('dormitoryId', ticket.dormitoryId),
    };
  }
}

/** A certificate ordered from the deanery; owned by the student who ordered it. */
@Injectable()
export class StudentDocumentResolver implements ResourceResolver {
  readonly types = [ResourceType.STUDENT_DOCUMENT] as const;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async resolve(type: ResourceType, id: string | undefined): Promise<Resource | null> {
    if (!id) return null;
    const row = await this.prisma.studentDocumentRequest.findUnique({ where: { id }, select: { tenantId: true, studentId: true } });
    return row ? { type, id, tenantId: row.tenantId, ownerId: row.studentId } : null;
  }
}
