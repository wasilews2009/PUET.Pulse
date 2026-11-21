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
  readonly types = [ResourceType.CHANNEL, ResourceType.MESSAGE, ResourceType.FILE] as const;

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

    return {
      type,
      id,
      tenantId: channel.tenantId,
      channelType: channel.type as ChannelType,
      e2eeMode: channel.e2eeMode as E2eeMode,
      confidential: channel.confidential || confidential,
      archived: channel.archivedAt !== null,
      isMember: activeMember,
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
