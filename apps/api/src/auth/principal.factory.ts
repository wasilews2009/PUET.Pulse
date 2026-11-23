import { Inject, Injectable } from '@nestjs/common';
import type { Principal, RoleGrant } from '@puet/policy-engine';
import type { AccountStatus, PrincipalKind, RoleCode } from '@puet/shared';
import { currentCourseOfferingIds } from '../authz/prisma-resolvers';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Builds the Principal for an authenticated user from the corporate directory.
 * The OIDC session layer (Phase 2) calls this after validating the token and the
 * user's session epoch. All ABAC attributes come from here, never from the client.
 */
@Injectable()
export class PrincipalFactory {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async build(
    userId: string,
    opts: { mfaVerified: boolean },
  ): Promise<{ principal: Principal; sessionEpoch: number } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        roleAssignments: true,
        studentProfile: { include: { dormitoryRoom: { select: { dormitoryId: true } } } },
        staffProfile: { include: { departments: true, orgUnits: true } },
      },
    });
    if (!user) return null;

    const roles: RoleGrant[] = user.roleAssignments.map((r) => ({
      role: r.role as RoleCode,
      tenantId: r.tenantId ?? '*',
      ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
      scope: {
        ...(r.instituteId ? { instituteId: r.instituteId } : {}),
        ...(r.departmentId ? { departmentId: r.departmentId } : {}),
        ...(r.orgUnitId ? { orgUnitId: r.orgUnitId } : {}),
        ...(r.dormitoryId ? { dormitoryId: r.dormitoryId } : {}),
      },
    }));

    const student = user.studentProfile;
    const staff = user.staffProfile;

    const principal: Principal = {
      userId: user.id,
      tenantId: user.tenantId,
      kind: user.kind as PrincipalKind,
      status: user.status as AccountStatus,
      roles,
      isMinor: user.isMinor,
      mfaVerified: opts.mfaVerified,
      instituteIds: student?.instituteId ? [student.instituteId] : [],
      departmentIds: staff?.departments.map((d) => d.departmentId) ?? [],
      orgUnitIds: staff?.orgUnits.map((o) => o.orgUnitId) ?? [],
      academicGroupIds: student?.academicGroupId ? [student.academicGroupId] : [],
      ...(student?.dormitoryRoom?.dormitoryId ? { dormitoryId: student.dormitoryRoom.dormitoryId } : {}),
      activeCourseOfferingIds: await currentCourseOfferingIds(
        this.prisma,
        student?.academicGroupId ?? null,
        staff?.id ?? null,
      ),
    };
    return { principal, sessionEpoch: user.sessionEpoch };
  }
}
