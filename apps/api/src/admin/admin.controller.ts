import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Action, ResourceType } from '@puet/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedRequest } from '../auth/principal';
import { Authorize } from '../authz/authorize.decorator';
import { parse } from '../common/validation';
import {
  auditQuery,
  auditVerifyQuery,
  departmentInput,
  departmentUpdate,
  dormitoryInput,
  instituteInput,
  instituteUpdate,
  orgUnitInput,
  orgUnitUpdate,
  permissionUpdate,
  policyInput,
  policyUpdate,
  promoteInput,
  roleGrantInput,
  simulateInput,
} from './admin.schemas';
import { ProvisioningService } from '../provisioning/provisioning.service';
import { PoliciesService } from './policies.service';
import { RolesService } from './roles.service';
import { StructureService, type Actor } from './structure.service';

const STRUCTURE = { type: ResourceType.STRUCTURE, idField: 'tenantId' } as const;
const ROLES = { type: ResourceType.ROLE, idField: 'tenantId' } as const;
const POLICY = { type: ResourceType.POLICY } as const;

const actor = (req: AuthenticatedRequest): Actor => ({
  userId: req.principal!.userId,
  ...(req.ip ? { ip: req.ip } : {}),
  ...(req.requestId ? { requestId: req.requestId } : {}),
});
/** Tenant authorized by the guard: never the raw path value. */
const tenant = (req: AuthenticatedRequest) => req.authz!.resource.tenantId;

/**
 * No-Code Admin Panel API (Information Center). The visual panel is built on
 * this API in Phase 5. Every route is MFA-gated through the SUPER_ADMIN grant.
 */
@Controller('admin')
export class AdminController {
  constructor(
    @Inject(StructureService) private readonly structure: StructureService,
    @Inject(RolesService) private readonly roles: RolesService,
    @Inject(PoliciesService) private readonly policies: PoliciesService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ProvisioningService) private readonly provisioning: ProvisioningService,
  ) {}

  // ── Tenants & structure ──────────────────────────────────────────

  @Get('tenants/:tenantId/structure')
  @Authorize(Action.STRUCTURE_MANAGE, STRUCTURE)
  getStructure(@Req() req: AuthenticatedRequest) {
    return this.structure.getStructure(tenant(req));
  }

  @Post('tenants/:tenantId/institutes')
  @Authorize(Action.STRUCTURE_MANAGE, STRUCTURE)
  createInstitute(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.structure.createInstitute(actor(req), tenant(req), parse(instituteInput, body));
  }

  @Patch('tenants/:tenantId/institutes/:id')
  @Authorize(Action.STRUCTURE_MANAGE, STRUCTURE)
  updateInstitute(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.structure.updateInstitute(actor(req), tenant(req), id, parse(instituteUpdate, body));
  }

  @Post('tenants/:tenantId/departments')
  @Authorize(Action.STRUCTURE_MANAGE, STRUCTURE)
  createDepartment(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.structure.createDepartment(actor(req), tenant(req), parse(departmentInput, body));
  }

  @Patch('tenants/:tenantId/departments/:id')
  @Authorize(Action.STRUCTURE_MANAGE, STRUCTURE)
  updateDepartment(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.structure.updateDepartment(actor(req), tenant(req), id, parse(departmentUpdate, body));
  }

  @Post('tenants/:tenantId/org-units')
  @Authorize(Action.STRUCTURE_MANAGE, STRUCTURE)
  createOrgUnit(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.structure.createOrgUnit(actor(req), tenant(req), parse(orgUnitInput, body));
  }

  @Patch('tenants/:tenantId/org-units/:id')
  @Authorize(Action.STRUCTURE_MANAGE, STRUCTURE)
  updateOrgUnit(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.structure.updateOrgUnit(actor(req), tenant(req), id, parse(orgUnitUpdate, body));
  }

  @Post('tenants/:tenantId/dormitories')
  @Authorize(Action.STRUCTURE_MANAGE, STRUCTURE)
  createDormitory(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.structure.createDormitory(actor(req), tenant(req), parse(dormitoryInput, body));
  }

  @Post('tenants/:tenantId/academic-groups/promote')
  @HttpCode(200)
  @Authorize(Action.STRUCTURE_MANAGE, STRUCTURE)
  promote(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.structure.promoteGroups(actor(req), tenant(req), parse(promoteInput, body ?? {}));
  }

  @Post('tenants/:tenantId/academic-groups/:groupId/graduate')
  @HttpCode(200)
  @Authorize(Action.STRUCTURE_MANAGE, STRUCTURE)
  graduate(@Req() req: AuthenticatedRequest, @Param('groupId', ParseUUIDPipe) groupId: string) {
    return this.structure.graduateGroup(actor(req), tenant(req), groupId);
  }

  /** Re-derive channels and memberships from the structure (also runs after every sync). */
  @Post('tenants/:tenantId/channels/provision')
  @HttpCode(200)
  @Authorize(Action.STRUCTURE_MANAGE, STRUCTURE)
  provision(@Req() req: AuthenticatedRequest) {
    return this.provisioning.reconcileTenant(tenant(req), req.principal!.userId);
  }

  // ── Roles ────────────────────────────────────────────────────────

  @Get('tenants/:tenantId/role-assignments')
  @Authorize(Action.ROLE_ASSIGN, ROLES)
  listRoles(@Req() req: AuthenticatedRequest, @Query('userId') userId?: string) {
    return this.roles.list(tenant(req), typeof userId === 'string' && /^[0-9a-f-]{36}$/i.test(userId) ? userId : undefined);
  }

  @Post('tenants/:tenantId/role-assignments')
  @Authorize(Action.ROLE_ASSIGN, ROLES)
  grant(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.roles.grant(actor(req), tenant(req), parse(roleGrantInput, body));
  }

  @Delete('tenants/:tenantId/role-assignments/:assignmentId')
  @Authorize(Action.ROLE_ASSIGN, ROLES)
  revoke(@Req() req: AuthenticatedRequest, @Param('assignmentId', ParseUUIDPipe) assignmentId: string) {
    return this.roles.revoke(actor(req), tenant(req), assignmentId);
  }

  // ── Permission matrix & ABAC policies ────────────────────────────

  @Get('permissions')
  @Authorize(Action.POLICY_MANAGE, POLICY)
  matrix() {
    return this.policies.matrix();
  }

  @Put('permissions/:role')
  @Authorize(Action.POLICY_MANAGE, POLICY)
  setRole(@Req() req: AuthenticatedRequest, @Param('role') role: string, @Body() body: unknown) {
    return this.policies.setRoleActions(actor(req), role, parse(permissionUpdate, body).actions);
  }

  @Get('policies')
  @Authorize(Action.POLICY_MANAGE, POLICY)
  listPolicies() {
    return this.policies.listPolicies();
  }

  @Post('policies')
  @Authorize(Action.POLICY_MANAGE, POLICY)
  createPolicy(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.policies.createPolicy(actor(req), parse(policyInput, body));
  }

  @Patch('policies/:id')
  @Authorize(Action.POLICY_MANAGE, POLICY)
  updatePolicy(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.policies.updatePolicy(actor(req), id, parse(policyUpdate, body));
  }

  @Post('policies/simulate')
  @HttpCode(200)
  @Authorize(Action.POLICY_MANAGE, POLICY)
  simulate(@Body() body: unknown) {
    return this.policies.simulate(parse(simulateInput, body));
  }

  // ── Audit ────────────────────────────────────────────────────────

  @Get('tenants/:tenantId/audit')
  @Authorize(Action.AUDIT_READ, { type: ResourceType.AUDIT, idField: 'tenantId' })
  async auditLog(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(auditQuery, query);
    const rows = await this.audit.list(tenant(req), q);
    return { items: rows.map((r) => ({ ...r, id: r.id.toString() })), nextBeforeId: rows.at(-1)?.id.toString() ?? null };
  }

  @Get('audit/verify')
  @Authorize(Action.AUDIT_READ, { type: ResourceType.AUDIT })
  verify(@Query() query: unknown) {
    const q = parse(auditVerifyQuery, query);
    return this.audit.verifyRange(q.fromId, q.limit);
  }
}
