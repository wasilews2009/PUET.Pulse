import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { EducationLevel } from '@puet/database';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SESSION_STORE, type SessionStore } from '../session/session.store';
import type {
  departmentInput,
  departmentUpdate,
  dormitoryInput,
  instituteInput,
  instituteUpdate,
  orgUnitInput,
  orgUnitUpdate,
  promoteInput,
} from './admin.schemas';

/** Default last course year per education level, used by bulk promotion. */
export const DEFAULT_MAX_COURSE: Record<EducationLevel, number> = {
  LYCEUM: 11,
  JUNIOR_BACHELOR: 4,
  BACHELOR: 4,
  MASTER: 2,
  PHD: 4,
  DOCTORATE: 3,
};

export interface Actor {
  userId: string;
  ip?: string;
  requestId?: string;
}

/**
 * Structure constructor of the No-Code Admin Panel. Every write is scoped to
 * the tenant the guard authorized, checks that referenced rows belong to that
 * tenant (no cross-tenant IDOR) and is audited. Rows are deactivated, not deleted,
 * so history and archives stay intact. ABAC attributes are rebuilt from the DB
 * on every request, so changes apply immediately.
 */
@Injectable()
export class StructureService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SESSION_STORE) private readonly sessions: SessionStore,
  ) {}

  async getStructure(tenantId: string) {
    const [tenant, institutes, departments, orgUnits, dormitories, groups] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
      this.prisma.institute.findMany({ where: { tenantId }, orderBy: { code: 'asc' } }),
      this.prisma.department.findMany({ where: { tenantId }, orderBy: { code: 'asc' } }),
      this.prisma.orgUnit.findMany({ where: { tenantId }, orderBy: [{ kind: 'asc' }, { code: 'asc' }] }),
      this.prisma.dormitory.findMany({ where: { tenantId }, orderBy: { number: 'asc' } }),
      this.prisma.academicGroup.findMany({
        where: { tenantId, isActive: true },
        orderBy: { code: 'asc' },
        select: { id: true, code: true, instituteId: true, educationLevel: true, studyForm: true, courseYear: true },
      }),
    ]);
    return { tenant, institutes, departments, orgUnits, dormitories, academicGroups: groups };
  }

  async createInstitute(actor: Actor, tenantId: string, input: z.infer<typeof instituteInput>) {
    const row = await this.prisma.institute.create({ data: { tenantId, ...input } });
    await this.log(actor, tenantId, 'structure.institute.create', row.id, { code: input.code });
    return row;
  }

  async updateInstitute(actor: Actor, tenantId: string, id: string, input: z.infer<typeof instituteUpdate>) {
    await this.ensure(this.prisma.institute.findFirst({ where: { id, tenantId }, select: { id: true } }));
    const row = await this.prisma.institute.update({ where: { id }, data: input });
    await this.log(actor, tenantId, 'structure.institute.update', id, { fields: Object.keys(input) });
    return row;
  }

  async createDepartment(actor: Actor, tenantId: string, input: z.infer<typeof departmentInput>) {
    const row = await this.prisma.department.create({ data: { tenantId, ...input } });
    await this.log(actor, tenantId, 'structure.department.create', row.id, { code: input.code });
    return row;
  }

  async updateDepartment(actor: Actor, tenantId: string, id: string, input: z.infer<typeof departmentUpdate>) {
    await this.ensure(this.prisma.department.findFirst({ where: { id, tenantId }, select: { id: true } }));
    const row = await this.prisma.department.update({ where: { id }, data: input });
    await this.log(actor, tenantId, 'structure.department.update', id, { fields: Object.keys(input) });
    return row;
  }

  async createOrgUnit(actor: Actor, tenantId: string, input: z.infer<typeof orgUnitInput>) {
    if (input.parentId) await this.assertParent(tenantId, input.parentId, null);
    const row = await this.prisma.orgUnit.create({ data: { tenantId, ...input, parentId: input.parentId ?? null } });
    await this.log(actor, tenantId, 'structure.org_unit.create', row.id, { code: input.code, kind: input.kind });
    return row;
  }

  async updateOrgUnit(actor: Actor, tenantId: string, id: string, input: z.infer<typeof orgUnitUpdate>) {
    await this.ensure(this.prisma.orgUnit.findFirst({ where: { id, tenantId }, select: { id: true } }));
    if (input.parentId) await this.assertParent(tenantId, input.parentId, id);
    const row = await this.prisma.orgUnit.update({ where: { id }, data: input });
    await this.log(actor, tenantId, 'structure.org_unit.update', id, { fields: Object.keys(input) });
    return row;
  }

  async createDormitory(actor: Actor, tenantId: string, input: z.infer<typeof dormitoryInput>) {
    const campus = await this.prisma.orgUnit.findFirst({ where: { tenantId, kind: 'CAMPUS' }, select: { id: true } });
    const row = await this.prisma.dormitory.create({ data: { tenantId, campusId: campus?.id ?? null, ...input } });
    await this.log(actor, tenantId, 'structure.dormitory.create', row.id, { number: input.number });
    return row;
  }

  /** Масовий перевід на наступний курс. */
  async promoteGroups(actor: Actor, tenantId: string, input: z.infer<typeof promoteInput>) {
    const max = { ...DEFAULT_MAX_COURSE, ...input.maxCourseYear };
    const groups = await this.prisma.academicGroup.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, code: true, educationLevel: true, courseYear: true },
    });
    const promote = groups.filter((g) => g.courseYear < max[g.educationLevel]);
    const finalYear = groups.filter((g) => g.courseYear >= max[g.educationLevel]);

    if (!input.dryRun && promote.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        const ids = promote.map((g) => g.id);
        await tx.academicGroup.updateMany({ where: { id: { in: ids } }, data: { courseYear: { increment: 1 } } });
        await tx.studentProfile.updateMany({
          where: { academicGroupId: { in: ids }, courseYear: { not: null } },
          data: { courseYear: { increment: 1 } },
        });
      });
      await this.log(actor, tenantId, 'structure.groups.promote', null, { promoted: promote.length });
    }
    return {
      dryRun: input.dryRun,
      promoted: promote.map((g) => ({ id: g.id, code: g.code, from: g.courseYear, to: g.courseYear + 1 })),
      readyToGraduate: finalYear.map((g) => ({ id: g.id, code: g.code, courseYear: g.courseYear })),
    };
  }

  /** Міграція випускників до Асоціації випускників: students become alumni guests, the group is closed. */
  async graduateGroup(actor: Actor, tenantId: string, groupId: string) {
    const group = await this.ensure(
      this.prisma.academicGroup.findFirst({ where: { id: groupId, tenantId, isActive: true }, select: { id: true, code: true } }),
    );
    const students = await this.prisma.user.findMany({
      where: { tenantId, status: 'ACTIVE', studentProfile: { academicGroupId: group.id } },
      select: { id: true },
    });
    const ids = students.map((s) => s.id);
    await this.prisma.$transaction(async (tx) => {
      await tx.roleAssignment.deleteMany({ where: { userId: { in: ids }, role: { in: ['STUDENT', 'GROUP_LEADER'] } } });
      await tx.roleAssignment.createMany({
        data: ids.map((userId) => ({ userId, tenantId, role: 'GUEST' as const, source: 'ADMIN' as const, grantedById: actor.userId })),
      });
      await tx.user.updateMany({
        where: { id: { in: ids } },
        data: { kind: 'GUEST', isAlumni: true, isMinor: false, sessionEpoch: { increment: 1 } },
      });
      await tx.academicGroup.update({ where: { id: group.id }, data: { isActive: false } });
    });
    await Promise.all(ids.map((id) => this.sessions.destroyAllForUser(id)));
    await this.log(actor, tenantId, 'structure.group.graduate', group.id, { code: group.code, students: ids.length });
    return { groupId: group.id, graduated: ids.length };
  }

  private async assertParent(tenantId: string, parentId: string, selfId: string | null) {
    // Walk up the tree: the parent must be in the same tenant and must not create a cycle.
    let cursor: string | null = parentId;
    for (let depth = 0; cursor; depth++) {
      if (cursor === selfId || depth > 32) throw new BadRequestException('parentId would create a cycle');
      const node: { parentId: string | null } | null = await this.prisma.orgUnit.findFirst({
        where: { id: cursor, tenantId },
        select: { parentId: true },
      });
      if (!node) throw new ForbiddenException('Access denied');
      cursor = node.parentId;
    }
  }

  private async ensure<T>(query: Promise<T | null>): Promise<T> {
    const row = await query;
    if (!row) throw new NotFoundException();
    return row;
  }

  private log(actor: Actor, tenantId: string, action: string, resourceId: string | null, metadata: Record<string, unknown>) {
    return this.audit.record({
      actorId: actor.userId,
      tenantId,
      action,
      resourceType: 'structure',
      resourceId,
      outcome: 'SUCCESS',
      ip: actor.ip ?? null,
      requestId: actor.requestId ?? null,
      metadata,
    });
  }
}
