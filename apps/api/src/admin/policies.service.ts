import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, RoleCode as DbRoleCode } from '@puet/database';
import { DEFAULT_PERMISSION_MATRIX, validateCondition, type Decision } from '@puet/policy-engine';
import { Action, ResourceType, RoleCode } from '@puet/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { PrincipalFactory } from '../auth/principal.factory';
import { RESOURCE_RESOLVERS, type ResourceResolver } from '../authz/resource-resolver';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import type { policyInput, policyUpdate, simulateInput } from './admin.schemas';
import type { Actor } from './structure.service';

/** Actions SUPER_ADMIN must always keep, so nobody can lock the administrators out. */
export const SUPER_ADMIN_LOCKED: readonly Action[] = [
  Action.SESSION_READ,
  Action.ROLE_ASSIGN,
  Action.POLICY_MANAGE,
  Action.STRUCTURE_MANAGE,
  Action.AUDIT_READ,
];

const RESOURCE_TYPES = new Set<string>([...Object.values(ResourceType), '*']);

/**
 * Permission matrix and ABAC policy editor of the No-Code Admin Panel, plus a
 * simulator that answers "can user X do Y on Z" with the live engine.
 * Every change invalidates the policy cache and is audited with before/after.
 */
@Injectable()
export class PoliciesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(PrincipalFactory) private readonly principals: PrincipalFactory,
    @Inject(RESOURCE_RESOLVERS) private readonly resolvers: ResourceResolver[],
  ) {}

  async matrix() {
    const rows = await this.prisma.rolePermission.findMany({ orderBy: [{ role: 'asc' }, { action: 'asc' }] });
    const fromDb: Record<string, string[]> = {};
    for (const r of rows) (fromDb[r.role] ??= []).push(r.action);
    return {
      source: rows.length > 0 ? 'database' : 'default',
      roles: rows.length > 0 ? fromDb : DEFAULT_PERMISSION_MATRIX,
      actions: Object.values(Action),
    };
  }

  async setRoleActions(actor: Actor, role: string, actions: string[]) {
    if (!Object.values(RoleCode).includes(role as RoleCode)) throw new NotFoundException();
    if (role === RoleCode.INTEGRATION) throw new BadRequestException('INTEGRATION permissions are fixed');
    if (role === RoleCode.SUPER_ADMIN) {
      const missing = SUPER_ADMIN_LOCKED.filter((a) => !actions.includes(a));
      if (missing.length > 0) throw new BadRequestException(`SUPER_ADMIN must keep: ${missing.join(', ')}`);
    }
    const unique = [...new Set(actions)];
    const before = await this.prisma.rolePermission.findMany({ where: { role: role as DbRoleCode }, select: { action: true } });

    await this.prisma.$transaction(async (tx) => {
      // First edit: materialize the default matrix so other roles keep their permissions.
      if ((await tx.rolePermission.count()) === 0) {
        const seed = Object.entries(DEFAULT_PERMISSION_MATRIX).flatMap(([r, acts]) =>
          (acts ?? []).map((a) => ({ role: r as DbRoleCode, action: a })),
        );
        await tx.rolePermission.createMany({ data: seed, skipDuplicates: true });
      }
      await tx.rolePermission.deleteMany({ where: { role: role as DbRoleCode } });
      await tx.rolePermission.createMany({ data: unique.map((action) => ({ role: role as DbRoleCode, action })) });
    });
    this.policy.invalidate();

    await this.log(actor, 'policy.matrix.update', role, {
      role,
      added: unique.filter((a) => !before.some((b) => b.action === a)),
      removed: before.map((b) => b.action).filter((a) => !unique.includes(a)),
    });
    return { role, actions: unique };
  }

  listPolicies() {
    return this.prisma.abacPolicy.findMany({ orderBy: [{ priority: 'desc' }, { key: 'asc' }] });
  }

  async createPolicy(actor: Actor, input: z.infer<typeof policyInput>) {
    this.validate(input);
    const row = await this.prisma.abacPolicy.create({
      data: {
        key: input.key,
        description: input.description ?? null,
        effect: input.effect,
        actions: input.actions,
        resourceTypes: input.resourceTypes,
        tenantId: input.tenantId ?? null,
        condition: input.condition as Prisma.InputJsonValue,
        priority: input.priority,
        enabled: input.enabled,
        createdById: actor.userId,
      },
    });
    this.policy.invalidate();
    await this.log(actor, 'policy.abac.create', row.id, { key: row.key, effect: row.effect, condition: input.condition });
    return row;
  }

  async updatePolicy(actor: Actor, id: string, input: z.infer<typeof policyUpdate>) {
    const existing = await this.prisma.abacPolicy.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException();
    this.validate({
      actions: input.actions ?? existing.actions,
      resourceTypes: input.resourceTypes ?? existing.resourceTypes,
      condition: input.condition === undefined ? existing.condition : input.condition,
    });
    const row = await this.prisma.abacPolicy.update({
      where: { id },
      data: {
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.effect ? { effect: input.effect } : {}),
        ...(input.actions ? { actions: input.actions } : {}),
        ...(input.resourceTypes ? { resourceTypes: input.resourceTypes } : {}),
        ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
        ...(input.condition !== undefined ? { condition: input.condition as Prisma.InputJsonValue } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        version: { increment: 1 },
      },
    });
    this.policy.invalidate();
    await this.log(actor, 'policy.abac.update', id, {
      key: existing.key,
      before: { effect: existing.effect, condition: existing.condition, enabled: existing.enabled },
      after: { effect: row.effect, condition: row.condition, enabled: row.enabled },
    });
    return row;
  }

  async simulate(input: z.infer<typeof simulateInput>): Promise<Decision & { resolved: boolean }> {
    const built = await this.principals.build(input.userId, { mfaVerified: input.mfaVerified });
    if (!built) throw new NotFoundException();
    const resolver = this.resolvers.find((r) => r.types.includes(input.resource.type as ResourceType));
    if (!resolver) throw new BadRequestException('Unknown resource type');
    const resource = await resolver.resolve(input.resource.type as ResourceType, input.resource.id, built.principal);
    if (!resource) return { allowed: false, reason: 'resource.not_found', resolved: false };
    const decision = await this.policy.evaluate(built.principal, input.action as Action, resource, { now: new Date() });
    return { ...decision, resolved: true };
  }

  private validate(p: { actions: readonly string[]; resourceTypes: readonly string[]; condition?: unknown }) {
    const error = validateCondition(p.condition);
    if (error) throw new BadRequestException(`Invalid condition: ${error}`);
    const badType = p.resourceTypes.find((t) => !RESOURCE_TYPES.has(t));
    if (badType) throw new BadRequestException(`Unknown resource type: ${badType}`);
    if (JSON.stringify(p.condition ?? null).length > 16_384) throw new BadRequestException('Condition too large');
  }

  private log(actor: Actor, action: string, resourceId: string, metadata: Record<string, unknown>) {
    return this.audit.record({
      actorId: actor.userId,
      action,
      resourceType: 'policy',
      resourceId,
      outcome: 'SUCCESS',
      ip: actor.ip ?? null,
      requestId: actor.requestId ?? null,
      metadata,
    });
  }
}
