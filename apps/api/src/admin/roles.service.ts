import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { RoleCode as DbRoleCode } from '@puet/database';
import { CROSS_TENANT_ROLES, MFA_REQUIRED_ROLES, RoleCode } from '@puet/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RoleGrantInput } from './admin.schemas';
import type { Actor } from './structure.service';

/**
 * Role assignment with separation-of-duties rules that hold no matter what the
 * permission matrix says:
 *  - nobody grants or revokes their own roles;
 *  - cross-tenant grants only for SUPER_ADMIN / RECTORATE;
 *  - scope ids must belong to the tenant;
 *  - guest grants must expire;
 *  - the last SUPER_ADMIN cannot be removed.
 */
@Injectable()
export class RolesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  list(tenantId: string, userId?: string) {
    return this.prisma.roleAssignment.findMany({
      where: { OR: [{ tenantId }, { tenantId: null, user: { tenantId } }], ...(userId ? { userId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true,
        userId: true,
        tenantId: true,
        role: true,
        instituteId: true,
        departmentId: true,
        orgUnitId: true,
        dormitoryId: true,
        expiresAt: true,
        source: true,
        createdAt: true,
      },
    });
  }

  async grant(actor: Actor, tenantId: string, input: RoleGrantInput) {
    const role = input.role as RoleCode;
    if (input.userId === actor.userId) throw new ForbiddenException('You cannot change your own roles');
    if (input.crossTenant && !CROSS_TENANT_ROLES.includes(role)) {
      throw new BadRequestException('Only SUPER_ADMIN and RECTORATE can be cross-tenant');
    }
    if (role === RoleCode.GUEST && !input.expiresAt) throw new BadRequestException('Guest access needs expiresAt');
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new BadRequestException('expiresAt is in the past');
    if (role === RoleCode.DEPARTMENT_HEAD && !input.departmentId) throw new BadRequestException('DEPARTMENT_HEAD needs departmentId');
    if (role === RoleCode.DORM_COMMANDANT && !input.dormitoryId) throw new BadRequestException('DORM_COMMANDANT needs dormitoryId');

    const user = await this.prisma.user.findFirst({ where: { id: input.userId, tenantId }, select: { id: true, kind: true, status: true } });
    if (!user) throw new NotFoundException();
    if (user.status === 'OFFBOARDED') throw new BadRequestException('User is offboarded');
    if (user.kind === 'SERVICE_BOT') throw new BadRequestException('Cannot grant roles to service accounts');

    await this.assertScopeInTenant(tenantId, input);

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.roleAssignment.create({
        data: {
          userId: input.userId,
          tenantId: input.crossTenant ? null : tenantId,
          role: role as DbRoleCode,
          instituteId: input.instituteId ?? null,
          departmentId: input.departmentId ?? null,
          orgUnitId: input.orgUnitId ?? null,
          dormitoryId: input.dormitoryId ?? null,
          expiresAt: input.expiresAt ?? null,
          grantedById: actor.userId,
          source: 'ADMIN',
        },
      });
      if (MFA_REQUIRED_ROLES.includes(role)) {
        await tx.user.update({ where: { id: input.userId }, data: { mfaEnforced: true } });
      }
      return created;
    });

    await this.log(actor, tenantId, 'role.grant', row.id, { userId: input.userId, role, crossTenant: input.crossTenant });
    return row;
  }

  async revoke(actor: Actor, tenantId: string, assignmentId: string) {
    const row = await this.prisma.roleAssignment.findFirst({
      where: { id: assignmentId, OR: [{ tenantId }, { tenantId: null, user: { tenantId } }] },
    });
    if (!row) throw new NotFoundException();
    if (row.userId === actor.userId) throw new ForbiddenException('You cannot change your own roles');
    if (row.source === 'SYNC') throw new BadRequestException('This role comes from the ЄДЕБО / HR sync; change it at the source');

    if (row.role === 'SUPER_ADMIN') {
      const remaining = await this.prisma.roleAssignment.count({
        where: { role: 'SUPER_ADMIN', id: { not: row.id }, user: { status: 'ACTIVE' } },
      });
      if (remaining === 0) throw new BadRequestException('Cannot remove the last SUPER_ADMIN');
    }
    await this.prisma.roleAssignment.delete({ where: { id: row.id } });
    await this.log(actor, tenantId, 'role.revoke', row.id, { userId: row.userId, role: row.role });
    return { revoked: row.id };
  }

  private async assertScopeInTenant(tenantId: string, s: RoleGrantInput) {
    const checks: Promise<unknown>[] = [];
    if (s.instituteId) checks.push(this.must(this.prisma.institute.findFirst({ where: { id: s.instituteId, tenantId } })));
    if (s.departmentId) checks.push(this.must(this.prisma.department.findFirst({ where: { id: s.departmentId, tenantId } })));
    if (s.orgUnitId) checks.push(this.must(this.prisma.orgUnit.findFirst({ where: { id: s.orgUnitId, tenantId } })));
    if (s.dormitoryId) checks.push(this.must(this.prisma.dormitory.findFirst({ where: { id: s.dormitoryId, tenantId } })));
    await Promise.all(checks);
  }

  private async must(q: Promise<unknown>) {
    if (!(await q)) throw new BadRequestException('Scope does not belong to this tenant');
  }

  private log(actor: Actor, tenantId: string, action: string, resourceId: string, metadata: Record<string, unknown>) {
    return this.audit.record({
      actorId: actor.userId,
      tenantId,
      action,
      resourceType: 'role',
      resourceId,
      outcome: 'SUCCESS',
      ip: actor.ip ?? null,
      requestId: actor.requestId ?? null,
      metadata,
    });
  }
}
