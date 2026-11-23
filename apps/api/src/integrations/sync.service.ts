import { TrustIntakeService } from '../trust/trust-intake.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, RoleCode as DbRoleCode } from '@puet/database';
import { RoleCode } from '@puet/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime.bus';
import { SESSION_STORE, type SessionStore } from '../session/session.store';
import { computeIsMinor, type Offboarding, type StaffRecord, type StudentRecord, type TeachingLoad } from './schemas';

export interface SyncResult {
  created: number;
  updated: number;
  offboarded: number;
  /** Per-record failures. Messages never contain personal data. */
  errors: { index: number; error: string }[];
}

type Tx = Prisma.TransactionClient;
type OffboardReason = 'EXPELLED' | 'GRADUATED' | 'DISMISSED' | 'DECEASED' | 'OTHER';

class RecordError extends Error {}

const emptyResult = (): SyncResult => ({ created: 0, updated: 0, offboarded: 0, errors: [] });

/**
 * Applies ЄДЕБО / HR / ERP data to the directory. Each record is its own
 * transaction, so one bad record does not block the batch. The sync owns only
 * role grants with source = SYNC; grants made by an administrator are untouched.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SESSION_STORE) private readonly sessions: SessionStore,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
    @Inject(TrustIntakeService) private readonly trust: TrustIntakeService,
  ) {}

  async syncStudents(tenantId: string, records: StudentRecord[], actorId: string): Promise<SyncResult> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const result = emptyResult();

    for (const [index, r] of records.entries()) {
      try {
        if (r.status === 'EXPELLED') {
          const user = await this.prisma.user.findUnique({ where: { edeboId: r.edeboId }, select: { id: true, tenantId: true } });
          if (user && user.tenantId === tenantId && (await this.offboardUser(user.id, 'EXPELLED', actorId))) result.offboarded++;
          continue;
        }
        const created = await this.prisma.$transaction((tx) => this.upsertStudent(tx, tenantId, tenant.minorProtected, r));
        created ? result.created++ : result.updated++;
      } catch (e) {
        result.errors.push({ index, error: this.describe(e) });
      }
    }
    await this.auditBatch(actorId, tenantId, 'sync.students', result);
    return result;
  }

  async syncStaff(tenantId: string, records: StaffRecord[], actorId: string): Promise<SyncResult> {
    const result = emptyResult();
    for (const [index, r] of records.entries()) {
      try {
        if (r.status === 'DISMISSED') {
          const user = await this.prisma.user.findUnique({ where: { hrId: r.hrId }, select: { id: true, tenantId: true } });
          if (user && user.tenantId === tenantId && (await this.offboardUser(user.id, 'DISMISSED', actorId))) result.offboarded++;
          continue;
        }
        const created = await this.prisma.$transaction((tx) => this.upsertStaff(tx, tenantId, r));
        created ? result.created++ : result.updated++;
      } catch (e) {
        result.errors.push({ index, error: this.describe(e) });
      }
    }
    await this.auditBatch(actorId, tenantId, 'sync.staff', result);
    return result;
  }

  async syncTeachingLoad(tenantId: string, load: TeachingLoad, actorId: string): Promise<SyncResult> {
    const result = emptyResult();
    const semester = await this.prisma.$transaction(async (tx) => {
      if (load.semester.isCurrent) {
        await tx.semester.updateMany({ where: { tenantId, isCurrent: true, NOT: { code: load.semester.code } }, data: { isCurrent: false } });
      }
      const data = {
        startsOn: new Date(load.semester.startsOn),
        endsOn: new Date(load.semester.endsOn),
        isCurrent: load.semester.isCurrent,
      };
      return tx.semester.upsert({
        where: { tenantId_code: { tenantId, code: load.semester.code } },
        update: data,
        create: { tenantId, code: load.semester.code, ...data },
      });
    });

    for (const [index, o] of load.offerings.entries()) {
      try {
        const created = await this.prisma.$transaction(async (tx) => {
          const department = await tx.department.findUnique({
            where: { tenantId_code: { tenantId, code: o.departmentCode } },
            select: { id: true },
          });
          if (!department) throw new RecordError('unknown departmentCode');

          const discipline = await tx.discipline.upsert({
            where: { tenantId_code: { tenantId, code: o.discipline.code } },
            update: { nameUk: o.discipline.nameUk, nameEn: o.discipline.nameEn, isElective: o.discipline.isElective, departmentId: department.id },
            create: { tenantId, departmentId: department.id, ...o.discipline },
          });

          const lecturers = await tx.staffProfile.findMany({
            where: { user: { hrId: { in: o.lecturerHrIds }, tenantId } },
            select: { id: true },
          });
          if (lecturers.length !== new Set(o.lecturerHrIds).size) throw new RecordError('unknown lecturerHrIds');
          const groups = await tx.academicGroup.findMany({ where: { tenantId, code: { in: o.groupCodes } }, select: { id: true } });
          if (groups.length !== new Set(o.groupCodes).size) throw new RecordError('unknown groupCodes');

          const existing = await tx.courseOffering.findUnique({
            where: { tenantId_externalId: { tenantId, externalId: o.externalId } },
            select: { id: true },
          });
          const offering = await tx.courseOffering.upsert({
            where: { tenantId_externalId: { tenantId, externalId: o.externalId } },
            update: { semesterId: semester.id, disciplineId: discipline.id, departmentId: department.id },
            create: { tenantId, externalId: o.externalId, semesterId: semester.id, disciplineId: discipline.id, departmentId: department.id },
          });
          await tx.courseOfferingLecturer.deleteMany({ where: { courseOfferingId: offering.id } });
          await tx.courseOfferingLecturer.createMany({
            data: lecturers.map((l, i) => ({ courseOfferingId: offering.id, staffProfileId: l.id, isLead: i === 0 })),
          });
          await tx.courseOfferingGroup.deleteMany({ where: { courseOfferingId: offering.id } });
          await tx.courseOfferingGroup.createMany({
            data: groups.map((g) => ({ courseOfferingId: offering.id, academicGroupId: g.id })),
          });
          return !existing;
        });
        created ? result.created++ : result.updated++;
      } catch (e) {
        result.errors.push({ index, error: this.describe(e) });
      }
    }
    await this.auditBatch(actorId, tenantId, 'sync.teaching_load', result);
    return result;
  }

  async processOffboarding(tenantId: string, batch: Offboarding, actorId: string): Promise<SyncResult> {
    const result = emptyResult();
    for (const [index, r] of batch.records.entries()) {
      try {
        const user = await this.prisma.user.findFirst({
          where: { tenantId, ...(r.edeboId ? { edeboId: r.edeboId } : { hrId: r.hrId! }) },
          select: { id: true },
        });
        if (!user) throw new RecordError('unknown person');
        if (await this.offboardUser(user.id, r.reason, actorId)) result.offboarded++;
      } catch (e) {
        result.errors.push({ index, error: this.describe(e) });
      }
    }
    await this.auditBatch(actorId, tenantId, 'sync.offboarding', result);
    return result;
  }

  /**
   * Blocks the account, invalidates every session at once (epoch bump + store purge),
   * revokes internal PKI certificates and removes sync grants. Messages and
   * documents stay in the archive. Returns false if already offboarded.
   */
  async offboardUser(userId: string, reason: OffboardReason, actorId: string | null): Promise<boolean> {
    const user = await this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { status: true, tenantId: true } });
      if (current.status === 'OFFBOARDED') return null;
      const now = new Date();
      await tx.user.update({
        where: { id: userId },
        data: { status: 'OFFBOARDED', offboardedAt: now, sessionEpoch: { increment: 1 }, presence: 'OFFLINE' },
      });
      await tx.userCertificate.updateMany({
        where: { userId, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: now, revocationReason: 'AFFILIATION_CHANGED' },
      });
      await tx.roleAssignment.deleteMany({ where: { userId, source: 'SYNC' } });
      // E2EE devices stop receiving keys; their one-time keys and pending envelopes go away.
      await tx.device.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, keysUpdatedAt: now } });
      await tx.deviceOneTimeKey.deleteMany({ where: { device: { userId } } });
      await tx.toDeviceMessage.deleteMany({ where: { recipient: { userId } } });
      return current;
    });
    if (!user) return false;

    // Anonymous appeals: closed, and their pseudonyms stop working with the person's account.
    const pseudonyms = await this.trust.pseudonymsOf(userId);
    await this.trust.offboard(userId);
    await this.sessions.destroyAllForUser(userId);
    await this.bus.disconnectUsers([userId, ...pseudonyms]);
    await this.audit.record({
      actorId,
      tenantId: user.tenantId,
      action: 'user.offboarded',
      resourceType: 'user',
      resourceId: userId,
      outcome: 'SUCCESS',
      reason,
    });
    return true;
  }

  private async upsertStudent(tx: Tx, tenantId: string, minorProtected: boolean, r: StudentRecord): Promise<boolean> {
    const institute = r.instituteCode
      ? await tx.institute.findUnique({ where: { tenantId_code: { tenantId, code: r.instituteCode } }, select: { id: true } })
      : null;
    if (r.instituteCode && !institute) throw new RecordError('unknown instituteCode');

    const group = r.groupCode
      ? await tx.academicGroup.upsert({
          where: { tenantId_code: { tenantId, code: r.groupCode } },
          update: {},
          create: {
            tenantId,
            code: r.groupCode,
            instituteId: institute?.id ?? null,
            educationLevel: r.educationLevel,
            studyForm: r.studyForm,
            courseYear: r.courseYear ?? 1,
            specialty: r.specialty ?? null,
          },
          select: { id: true },
        })
      : null;

    let roomId: string | null = null;
    if (r.dormitory) {
      const dorm = await tx.dormitory.findUnique({
        where: { tenantId_number: { tenantId, number: r.dormitory.number } },
        select: { id: true },
      });
      if (!dorm) throw new RecordError('unknown dormitory');
      const room = await tx.dormitoryRoom.upsert({
        where: { dormitoryId_number: { dormitoryId: dorm.id, number: r.dormitory.room } },
        update: { floor: r.dormitory.floor },
        create: { dormitoryId: dorm.id, number: r.dormitory.room, floor: r.dormitory.floor },
        select: { id: true },
      });
      roomId = room.id;
    }

    const { user, created } = await this.upsertPerson(tx, tenantId, { edeboId: r.edeboId }, r, {
      kind: 'STUDENT',
      isMinor: computeIsMinor(r.birthDate, minorProtected),
      status: r.status === 'ACADEMIC_LEAVE' ? 'SUSPENDED' : 'ACTIVE',
    });

    const profile = {
      educationLevel: r.educationLevel,
      studyForm: r.studyForm,
      instituteId: institute?.id ?? null,
      academicGroupId: group?.id ?? null,
      specialty: r.specialty ?? null,
      courseYear: r.courseYear ?? null,
      dormitoryRoomId: roomId,
      isGroupLeader: r.isGroupLeader,
      isActivist: r.isActivist,
      isForeign: r.isForeign,
    };
    await tx.studentProfile.upsert({ where: { userId: user.id }, update: profile, create: { userId: user.id, ...profile } });

    const grants: { role: DbRoleCode }[] = [{ role: RoleCode.STUDENT }];
    if (r.isGroupLeader) grants.push({ role: RoleCode.GROUP_LEADER });
    await this.replaceSyncGrants(tx, user.id, tenantId, grants);
    return created;
  }

  private async upsertStaff(tx: Tx, tenantId: string, r: StaffRecord): Promise<boolean> {
    const deptCodes = [...new Set([...(r.primaryDepartmentCode ? [r.primaryDepartmentCode] : []), ...r.departmentCodes])];
    const departments = await tx.department.findMany({ where: { tenantId, code: { in: deptCodes } }, select: { id: true, code: true } });
    if (departments.length !== deptCodes.length) throw new RecordError('unknown departmentCode');
    const orgUnits = await tx.orgUnit.findMany({ where: { tenantId, code: { in: r.orgUnitCodes } }, select: { id: true, code: true } });
    if (orgUnits.length !== new Set(r.orgUnitCodes).size) throw new RecordError('unknown orgUnitCode');

    // Resolve role scopes before writing anything.
    const grants: Omit<Prisma.RoleAssignmentCreateManyInput, 'userId' | 'tenantId' | 'source'>[] = [];
    for (const g of r.roles) {
      const scope: { instituteId?: string; departmentId?: string; orgUnitId?: string; dormitoryId?: string } = {};
      if (g.instituteCode) {
        const i = await tx.institute.findUnique({ where: { tenantId_code: { tenantId, code: g.instituteCode } }, select: { id: true } });
        if (!i) throw new RecordError('unknown role instituteCode');
        scope.instituteId = i.id;
      }
      if (g.departmentCode) {
        const d = await tx.department.findUnique({ where: { tenantId_code: { tenantId, code: g.departmentCode } }, select: { id: true } });
        if (!d) throw new RecordError('unknown role departmentCode');
        scope.departmentId = d.id;
      }
      if (g.orgUnitCode) {
        const o = await tx.orgUnit.findUnique({ where: { tenantId_code: { tenantId, code: g.orgUnitCode } }, select: { id: true } });
        if (!o) throw new RecordError('unknown role orgUnitCode');
        scope.orgUnitId = o.id;
      }
      if (g.dormitoryNumber !== undefined) {
        const dm = await tx.dormitory.findUnique({ where: { tenantId_number: { tenantId, number: g.dormitoryNumber } }, select: { id: true } });
        if (!dm) throw new RecordError('unknown role dormitoryNumber');
        scope.dormitoryId = dm.id;
      }
      if (g.role === RoleCode.DEPARTMENT_HEAD && !scope.departmentId) throw new RecordError('DEPARTMENT_HEAD needs departmentCode');
      if (g.role === RoleCode.DORM_COMMANDANT && !scope.dormitoryId) throw new RecordError('DORM_COMMANDANT needs dormitoryNumber');
      grants.push({ role: g.role as DbRoleCode, ...scope });
    }

    const { user, created } = await this.upsertPerson(tx, tenantId, { hrId: r.hrId }, r, {
      kind: 'STAFF',
      isMinor: false,
      status: r.status === 'ON_LEAVE' ? 'SUSPENDED' : 'ACTIVE',
    });

    const profileData = {
      position: r.position,
      academicDegree: r.academicDegree ?? null,
      academicTitle: r.academicTitle ?? null,
    };
    const profile = await tx.staffProfile.upsert({
      where: { userId: user.id },
      update: profileData,
      create: { userId: user.id, ...profileData },
      select: { id: true },
    });
    await tx.staffDepartment.deleteMany({ where: { staffProfileId: profile.id } });
    await tx.staffDepartment.createMany({
      data: departments.map((d) => ({ staffProfileId: profile.id, departmentId: d.id, isPrimary: d.code === r.primaryDepartmentCode })),
    });
    await tx.staffOrgUnit.deleteMany({ where: { staffProfileId: profile.id } });
    await tx.staffOrgUnit.createMany({ data: orgUnits.map((o) => ({ staffProfileId: profile.id, orgUnitId: o.id })) });

    await this.replaceSyncGrants(tx, user.id, tenantId, grants);
    return created;
  }

  private async upsertPerson(
    tx: Tx,
    tenantId: string,
    key: { edeboId: string } | { hrId: string },
    r: StudentRecord | StaffRecord,
    attrs: { kind: 'STUDENT' | 'STAFF'; isMinor: boolean; status: 'ACTIVE' | 'SUSPENDED' },
  ) {
    const existing = await tx.user.findUnique({ where: key, select: { id: true, tenantId: true, status: true } });
    if (existing && existing.tenantId !== tenantId) throw new RecordError('person belongs to another tenant');
    // An offboarded account is never silently reactivated by a sync.
    if (existing?.status === 'OFFBOARDED') throw new RecordError('person is offboarded');

    const data = {
      corporateId: r.corporateId,
      email: r.email,
      fullNameUk: r.fullNameUk,
      fullNameEn: r.fullNameEn ?? null,
      phone: r.phone ?? null,
      birthDate: r.birthDate ? new Date(r.birthDate) : null,
      isMinor: attrs.isMinor,
      kind: attrs.kind,
      status: attrs.status,
      ...(r.locale ? { locale: r.locale } : {}),
    } as const;

    if (existing) {
      const user = await tx.user.update({
        where: { id: existing.id },
        data: { ...data, ...(attrs.status !== existing.status ? { sessionEpoch: { increment: 1 } } : {}) },
        select: { id: true },
      });
      return { user, created: false };
    }
    const user = await tx.user.create({
      data: { tenantId, ...key, ...data, mfaEnforced: false },
      select: { id: true },
    });
    return { user, created: true };
  }

  private async replaceSyncGrants(
    tx: Tx,
    userId: string,
    tenantId: string,
    grants: Omit<Prisma.RoleAssignmentCreateManyInput, 'userId' | 'tenantId' | 'source'>[],
  ) {
    await tx.roleAssignment.deleteMany({ where: { userId, source: 'SYNC' } });
    if (grants.length === 0) return;
    await tx.roleAssignment.createMany({ data: grants.map((g) => ({ ...g, userId, tenantId, source: 'SYNC' as const })) });
    const privileged = grants.some((g) =>
      (['INSTITUTE_DIRECTOR', 'ADMIN_STAFF', 'TRUST_SERVICE_OFFICER'] as string[]).includes(g.role as string),
    );
    if (privileged) await tx.user.update({ where: { id: userId }, data: { mfaEnforced: true } });
  }

  private describe(e: unknown): string {
    if (e instanceof RecordError) return e.message;
    const code = (e as { code?: string }).code;
    if (code === 'P2002') return 'unique constraint violated (corporateId or email already used)';
    this.logger.error('Sync record failed', e as Error);
    return 'internal error';
  }

  private async auditBatch(actorId: string, tenantId: string, action: string, r: SyncResult) {
    await this.audit.record({
      actorId,
      tenantId,
      action,
      resourceType: 'integration',
      outcome: r.errors.length === 0 ? 'SUCCESS' : 'FAILURE',
      metadata: { created: r.created, updated: r.updated, offboarded: r.offboarded, errors: r.errors.length },
    });
  }
}
