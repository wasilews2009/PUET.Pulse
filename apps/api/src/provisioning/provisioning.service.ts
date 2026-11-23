import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ChannelType as DbChannelType, E2eeMode as DbE2eeMode, OrgUnitKind, Prisma } from '@puet/database';
import { ChannelType, E2eeMode, MemberRole, RoleCode } from '@puet/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime.bus';

type Desired = Map<string, MemberRole>;
type Db = Prisma.TransactionClient;
interface PendingEvent {
  userIds: string[];
  event: 'channel.joined' | 'channel.left';
  channelId: string;
}
/** pg_advisory_xact_lock class id for provisioning ("PROV"). */
const PROVISION_LOCK = 0x50524f56;

interface ChannelSpec {
  provisionKey: string;
  tenantId: string;
  type: DbChannelType;
  e2eeMode: DbE2eeMode;
  nameUk: string;
  nameEn: string;
  topic?: string | null;
  confidential?: boolean;
  isOfficial?: boolean;
  threadsRequired?: boolean;
  autoArchiveAt?: Date | null;
  instituteId?: string;
  departmentId?: string;
  orgUnitId?: string;
  dormitoryId?: string;
  academicGroupId?: string;
  courseOfferingId?: string;
}

export interface ProvisioningResult {
  channels: number;
  created: number;
  joined: number;
  left: number;
}

const ORG_UNIT_CHANNEL: Partial<Record<OrgUnitKind, DbChannelType>> = {
  GOVERNANCE: 'GOVERNANCE',
  ADMIN_SERVICE: 'ADMIN_UNIT',
  TRUST_SERVICE: 'TRUST_ROOM',
  SAFETY_SERVICE: 'ADMIN_UNIT',
  ACADEMIC_CENTER: 'PROJECT',
  FACILITIES: 'ADMIN_UNIT',
  COMMUNITY: 'COMMUNITY',
  // CAMPUS: dormitory channels instead. EXTERNAL: guest spaces are opened by hand with a TTL.
};

const ACTIVE_HUMAN: Prisma.UserWhereInput = { status: 'ACTIVE', kind: { in: ['STAFF', 'STUDENT'] } };
const activeGrant = (now: Date) => ({ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

/**
 * Channel auto-provisioning («система автоматично формує робочі простори»).
 *
 * Derives channels and their members from the synced structure: academic groups,
 * course offerings of each semester (with mandatory threads and auto-archive),
 * departments, institutes, dormitories, org units and the tenant-wide Civil
 * Protection channel. It owns only memberships with source = AUTO; people added
 * by hand (MANUAL) are never removed. Idempotent: run it after every sync.
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async reconcileTenant(tenantId: string, actorId: string | null = null, now = new Date()): Promise<ProvisioningResult> {
    const result: ProvisioningResult = { channels: 0, created: 0, joined: 0, left: 0 };
    const events: PendingEvent[] = [];

    // One reconcile per tenant at a time (concurrent webhooks), in one transaction.
    await this.prisma.$transaction(
      async (db) => {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(${PROVISION_LOCK}::int, hashtext(${tenantId}))`;
        const apply = async (spec: ChannelSpec, desired: Desired) => {
          const { id, created } = await this.ensureChannel(db, spec);
          result.channels++;
          if (created) result.created++;
          const changed = await this.syncMembers(db, id, desired, events);
          result.joined += changed.joined;
          result.left += changed.left;
        };
        await this.groups(db, tenantId, apply);
        await this.courses(db, tenantId, now, apply);
        await this.departments(db, tenantId, now, apply);
        await this.institutes(db, tenantId, now, apply);
        await this.dormitories(db, tenantId, now, apply);
        await this.orgUnits(db, tenantId, now, apply);
        await this.emergency(db, tenantId, now, apply);
      },
      { timeout: 120_000, maxWait: 30_000 },
    );

    // Tell clients only after the commit.
    for (const e of events) await this.bus.emitToUsers(e.userIds, e.event, { channelId: e.channelId });
    await this.audit.record({
      actorId,
      tenantId,
      action: 'channels.provision',
      resourceType: 'channel',
      outcome: 'SUCCESS',
      metadata: { ...result },
    });
    return result;
  }

  /** Course channels become read-only after the semester (and its exam session) ends. */
  async archiveEndedCourses(now = new Date()): Promise<number> {
    const { count } = await this.prisma.channel.updateMany({
      where: { type: 'COURSE', archivedAt: null, autoArchiveAt: { lte: now } },
      data: { archivedAt: now },
    });
    if (count) this.logger.log(`Archived ${count} course channels`);
    return count;
  }

  // ───────────────────────────── Rules ─────────────────────────────

  private async groups(db: Db, tenantId: string, apply: (s: ChannelSpec, d: Desired) => Promise<void>) {
    const groups = await db.academicGroup.findMany({
      where: { tenantId, isActive: true },
      select: {
        id: true,
        code: true,
        instituteId: true,
        students: { where: { user: ACTIVE_HUMAN }, select: { userId: true, isGroupLeader: true } },
      },
    });
    for (const g of groups) {
      const desired: Desired = new Map(
        g.students.map((s) => [s.userId, s.isGroupLeader ? MemberRole.MODERATOR : MemberRole.MEMBER]),
      );
      await apply(
        {
          provisionKey: `group:${g.id}`,
          tenantId,
          type: ChannelType.ACADEMIC_GROUP,
          e2eeMode: E2eeMode.DISABLED,
          nameUk: `Група ${g.code}`,
          nameEn: `Group ${g.code}`,
          isOfficial: true,
          academicGroupId: g.id,
          ...(g.instituteId ? { instituteId: g.instituteId } : {}),
        },
        desired,
      );
    }
  }

  private async courses(db: Db, tenantId: string, now: Date, apply: (s: ChannelSpec, d: Desired) => Promise<void>) {
    const offerings = await db.courseOffering.findMany({
      where: { tenantId, OR: [{ channel: null }, { channel: { archivedAt: null } }] },
      select: {
        id: true,
        departmentId: true,
        semester: { select: { code: true, endsOn: true } },
        discipline: { select: { nameUk: true, nameEn: true } },
        lecturers: {
          where: { staffProfile: { user: ACTIVE_HUMAN } },
          select: { isLead: true, staffProfile: { select: { userId: true } } },
        },
        groups: {
          select: {
            academicGroup: {
              select: { isActive: true, students: { where: { user: ACTIVE_HUMAN }, select: { userId: true } } },
            },
          },
        },
      },
    });
    for (const o of offerings) {
      // Archive the day after the semester's last date (exam session included in endsOn).
      const archiveAt = new Date(o.semester.endsOn.getTime() + 86_400_000);
      const desired: Desired = new Map();
      for (const g of o.groups) {
        if (!g.academicGroup.isActive) continue;
        for (const s of g.academicGroup.students) desired.set(s.userId, MemberRole.MEMBER);
      }
      for (const l of o.lecturers) {
        desired.set(l.staffProfile.userId, l.isLead ? MemberRole.OWNER : MemberRole.MODERATOR);
      }
      await apply(
        {
          provisionKey: `course:${o.id}`,
          tenantId,
          type: ChannelType.COURSE,
          e2eeMode: E2eeMode.DISABLED,
          nameUk: o.discipline.nameUk,
          nameEn: o.discipline.nameEn,
          topic: o.semester.code,
          isOfficial: true,
          threadsRequired: true,
          autoArchiveAt: archiveAt,
          departmentId: o.departmentId,
          courseOfferingId: o.id,
        },
        archiveAt <= now ? new Map() : desired,
      );
    }
  }

  private async departments(db: Db, tenantId: string, now: Date, apply: (s: ChannelSpec, d: Desired) => Promise<void>) {
    const departments = await db.department.findMany({
      where: { tenantId, isActive: true },
      select: {
        id: true,
        nameUk: true,
        nameEn: true,
        staff: { where: { staffProfile: { user: ACTIVE_HUMAN } }, select: { staffProfile: { select: { userId: true } } } },
      },
    });
    const heads = await db.roleAssignment.findMany({
      where: { tenantId, role: RoleCode.DEPARTMENT_HEAD, departmentId: { not: null }, ...activeGrant(now), user: ACTIVE_HUMAN },
      select: { userId: true, departmentId: true },
    });
    for (const d of departments) {
      const desired: Desired = new Map(d.staff.map((s) => [s.staffProfile.userId, MemberRole.MEMBER]));
      for (const h of heads) if (h.departmentId === d.id) desired.set(h.userId, MemberRole.OWNER);
      await apply(
        {
          provisionKey: `department:${d.id}`,
          tenantId,
          type: ChannelType.DEPARTMENT,
          e2eeMode: E2eeMode.DISABLED,
          nameUk: `Кафедра ${d.nameUk.charAt(0).toLowerCase()}${d.nameUk.slice(1)}`,
          nameEn: `Department of ${d.nameEn}`,
          isOfficial: true,
          departmentId: d.id,
        },
        desired,
      );
    }
  }

  /** Institute announcements: directors post, students and the institute's lecturers read. */
  private async institutes(db: Db, tenantId: string, now: Date, apply: (s: ChannelSpec, d: Desired) => Promise<void>) {
    const institutes = await db.institute.findMany({
      where: { tenantId, isActive: true },
      select: {
        id: true,
        nameUk: true,
        nameEn: true,
        students: { where: { user: ACTIVE_HUMAN }, select: { userId: true } },
      },
    });
    const directors = await db.roleAssignment.findMany({
      where: { tenantId, role: RoleCode.INSTITUTE_DIRECTOR, instituteId: { not: null }, ...activeGrant(now), user: ACTIVE_HUMAN },
      select: { userId: true, instituteId: true },
    });
    for (const i of institutes) {
      const desired: Desired = new Map(i.students.map((s) => [s.userId, MemberRole.MEMBER]));
      for (const d of directors) if (d.instituteId === i.id) desired.set(d.userId, MemberRole.OWNER);
      await apply(
        {
          provisionKey: `institute:${i.id}`,
          tenantId,
          type: ChannelType.ANNOUNCEMENT,
          e2eeMode: E2eeMode.DISABLED,
          nameUk: i.nameUk,
          nameEn: i.nameEn,
          isOfficial: true,
          instituteId: i.id,
        },
        desired,
      );
    }
  }

  private async dormitories(db: Db, tenantId: string, now: Date, apply: (s: ChannelSpec, d: Desired) => Promise<void>) {
    const dorms = await db.dormitory.findMany({
      where: { tenantId },
      select: {
        id: true,
        nameUk: true,
        nameEn: true,
        rooms: { select: { residents: { where: { user: ACTIVE_HUMAN }, select: { userId: true } } } },
      },
    });
    const commandants = await db.roleAssignment.findMany({
      where: { tenantId, role: RoleCode.DORM_COMMANDANT, dormitoryId: { not: null }, ...activeGrant(now), user: ACTIVE_HUMAN },
      select: { userId: true, dormitoryId: true },
    });
    for (const d of dorms) {
      const desired: Desired = new Map();
      for (const r of d.rooms) for (const s of r.residents) desired.set(s.userId, MemberRole.MEMBER);
      for (const c of commandants) if (c.dormitoryId === d.id) desired.set(c.userId, MemberRole.OWNER);
      await apply(
        {
          provisionKey: `dormitory:${d.id}`,
          tenantId,
          type: ChannelType.DORMITORY,
          e2eeMode: E2eeMode.DISABLED,
          nameUk: d.nameUk,
          nameEn: d.nameEn,
          dormitoryId: d.id,
        },
        desired,
      );
    }
  }

  private async orgUnits(db: Db, tenantId: string, now: Date, apply: (s: ChannelSpec, d: Desired) => Promise<void>) {
    const units = await db.orgUnit.findMany({
      where: { tenantId, isActive: true },
      select: {
        id: true,
        code: true,
        kind: true,
        nameUk: true,
        nameEn: true,
        confidential: true,
        e2eeMode: true,
        members: { where: { staffProfile: { user: ACTIVE_HUMAN } }, select: { staffProfile: { select: { userId: true } } } },
      },
    });
    const scoped = await db.roleAssignment.findMany({
      where: { tenantId, orgUnitId: { not: null }, ...activeGrant(now), user: ACTIVE_HUMAN },
      select: { userId: true, orgUnitId: true },
    });
    const rectorate = await db.roleAssignment.findMany({
      where: {
        role: RoleCode.RECTORATE,
        AND: [{ OR: [{ tenantId }, { tenantId: null }] }, activeGrant(now)],
        user: { ...ACTIVE_HUMAN, tenantId },
      },
      select: { userId: true },
    });
    for (const u of units) {
      const type = ORG_UNIT_CHANNEL[u.kind];
      if (!type) continue;
      const desired: Desired = new Map(u.members.map((m) => [m.staffProfile.userId, MemberRole.MEMBER]));
      for (const s of scoped) if (s.orgUnitId === u.id) desired.set(s.userId, MemberRole.MODERATOR);
      if (u.code === 'RECTORATE') for (const r of rectorate) desired.set(r.userId, MemberRole.OWNER);
      await apply(
        {
          provisionKey: `orgunit:${u.id}`,
          tenantId,
          type,
          e2eeMode: u.e2eeMode,
          nameUk: u.nameUk,
          nameEn: u.nameEn,
          confidential: u.confidential,
          isOfficial: u.kind === 'GOVERNANCE',
          orgUnitId: u.id,
        },
        desired,
      );
    }
  }

  /** Civil Protection alerts reach every person of the tenant and bypass Quiet Hours. */
  private async emergency(db: Db, tenantId: string, now: Date, apply: (s: ChannelSpec, d: Desired) => Promise<void>) {
    const civil = await db.orgUnit.findFirst({
      where: { tenantId, kind: 'SAFETY_SERVICE', isActive: true },
      select: { id: true },
    });
    if (!civil) return;
    const [people, officers] = await Promise.all([
      db.user.findMany({ where: { tenantId, ...ACTIVE_HUMAN }, select: { id: true } }),
      db.roleAssignment.findMany({
        where: { tenantId, role: RoleCode.CIVIL_PROTECTION_OFFICER, ...activeGrant(now), user: ACTIVE_HUMAN },
        select: { userId: true },
      }),
    ]);
    const desired: Desired = new Map(people.map((p) => [p.id, MemberRole.READ_ONLY]));
    for (const o of officers) desired.set(o.userId, MemberRole.OWNER);
    await apply(
      {
        provisionKey: `emergency:${tenantId}`,
        tenantId,
        type: ChannelType.EMERGENCY,
        e2eeMode: E2eeMode.DISABLED,
        nameUk: 'Термінові сповіщення ЦЗ',
        nameEn: 'Civil Protection Alerts',
        isOfficial: true,
        orgUnitId: civil.id,
      },
      desired,
    );
  }

  // ───────────────────────────── Mechanics ─────────────────────────────

  private async ensureChannel(db: Db, spec: ChannelSpec): Promise<{ id: string; created: boolean }> {
    const existing = await db.channel.findUnique({ where: { provisionKey: spec.provisionKey }, select: { id: true } });
    const data = {
      type: spec.type,
      e2eeMode: spec.e2eeMode,
      nameUk: spec.nameUk,
      nameEn: spec.nameEn,
      confidential: spec.confidential ?? false,
      isOfficial: spec.isOfficial ?? false,
      threadsRequired: spec.threadsRequired ?? false,
      ...(spec.topic !== undefined ? { topic: spec.topic } : {}),
      ...(spec.autoArchiveAt !== undefined ? { autoArchiveAt: spec.autoArchiveAt } : {}),
    };
    if (existing) {
      // The structure is the source of truth for names and flags. E2EE mode never
      // downgrades: a channel that is encrypted stays encrypted.
      const { e2eeMode, ...rest } = data;
      await db.channel.update({
        where: { id: existing.id },
        data: { ...rest, ...(e2eeMode === E2eeMode.MANDATORY ? { e2eeMode } : {}) },
      });
      return { id: existing.id, created: false };
    }

    // Adopt a channel created by the seed for the same org unit (emergency, governance).
    if (spec.orgUnitId) {
      const legacy = await db.channel.findFirst({
        where: { tenantId: spec.tenantId, orgUnitId: spec.orgUnitId, type: spec.type, provisionKey: null },
        select: { id: true },
      });
      if (legacy) {
        await db.channel.update({ where: { id: legacy.id }, data: { provisionKey: spec.provisionKey } });
        return { id: legacy.id, created: false };
      }
    }

    const created = await db.channel.create({
      data: {
        ...data,
        tenantId: spec.tenantId,
        provisionKey: spec.provisionKey,
        instituteId: spec.instituteId ?? null,
        departmentId: spec.departmentId ?? null,
        orgUnitId: spec.orgUnitId ?? null,
        dormitoryId: spec.dormitoryId ?? null,
        academicGroupId: spec.academicGroupId ?? null,
        courseOfferingId: spec.courseOfferingId ?? null,
      },
      select: { id: true },
    });
    return { id: created.id, created: true };
  }

  private async syncMembers(db: Db, channelId: string, desired: Desired, events: PendingEvent[]): Promise<{ joined: number; left: number }> {
    const existing = await db.channelMember.findMany({
      where: { channelId },
      select: { userId: true, role: true, source: true },
    });
    const byUser = new Map(existing.map((m) => [m.userId, m]));

    const toCreate = [...desired].filter(([id]) => !byUser.has(id));
    const toRemove = existing.filter((m) => m.source === 'AUTO' && !desired.has(m.userId)).map((m) => m.userId);
    const toUpdate = existing.filter((m) => m.source === 'AUTO' && desired.has(m.userId) && desired.get(m.userId) !== m.role);

    if (toCreate.length) {
      await db.channelMember.createMany({
        data: toCreate.map(([userId, role]) => ({ channelId, userId, role, source: 'AUTO' as const })),
        skipDuplicates: true,
      });
    }
    if (toRemove.length) {
      await db.channelMember.deleteMany({ where: { channelId, userId: { in: toRemove }, source: 'AUTO' } });
    }
    for (const m of toUpdate) {
      await db.channelMember.update({
        where: { channelId_userId: { channelId, userId: m.userId } },
        data: { role: desired.get(m.userId)! },
      });
    }

    if (toCreate.length) events.push({ userIds: toCreate.map(([id]) => id), event: 'channel.joined', channelId });
    if (toRemove.length) events.push({ userIds: toRemove, event: 'channel.left', channelId });
    return { joined: toCreate.length, left: toRemove.length };
  }
}
