import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_PERMISSION_MATRIX,
  PolicyEngine,
  validateCondition,
  type ConfigurablePolicy,
  type Decision,
  type Environment,
  type PermissionMatrix,
  type Principal,
  type Resource,
} from '@puet/policy-engine';
import type { Action, ResourceType, RoleCode } from '@puet/shared';
import { PrismaService } from '../prisma/prisma.service';

export const POLICY_STORE = Symbol('POLICY_STORE');

export interface PolicySnapshot {
  matrix: PermissionMatrix;
  policies: ConfigurablePolicy[];
  phoneAccessOrgUnitIds: string[];
}

export interface PolicyStore {
  load(): Promise<PolicySnapshot>;
}

/** Reads the admin-configured matrix and ABAC rules from PostgreSQL. */
@Injectable()
export class PrismaPolicyStore implements PolicyStore {
  private readonly logger = new Logger(PrismaPolicyStore.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async load(): Promise<PolicySnapshot> {
    const [perms, rules, hrUnits] = await Promise.all([
      this.prisma.rolePermission.findMany(),
      this.prisma.abacPolicy.findMany({ where: { enabled: true } }),
      this.prisma.orgUnit.findMany({ where: { code: 'HR', isActive: true }, select: { id: true } }),
    ]);

    const matrix: Partial<Record<RoleCode, Action[]>> = {};
    for (const p of perms) (matrix[p.role as RoleCode] ??= []).push(p.action as Action);

    const policies: ConfigurablePolicy[] = [];
    for (const r of rules) {
      const error = validateCondition(r.condition);
      if (error && r.effect === 'ALLOW') {
        this.logger.warn(`Skipping invalid ALLOW policy ${r.key}: ${error}`);
        continue;
      }
      policies.push({
        id: r.key,
        effect: r.effect === 'DENY' ? 'deny' : 'allow',
        actions: r.actions as Action[],
        resourceTypes: r.resourceTypes as ResourceType[],
        ...(r.tenantId ? { tenantId: r.tenantId } : {}),
        // An invalid DENY rule is kept: the engine treats it as matching (fail closed).
        condition: r.condition as ConfigurablePolicy['condition'],
        priority: r.priority,
      });
    }

    return {
      matrix: perms.length > 0 ? matrix : DEFAULT_PERMISSION_MATRIX,
      policies,
      phoneAccessOrgUnitIds: hrUnits.map((u) => u.id),
    };
  }
}

/**
 * Caches a PolicyEngine built from the store for a short TTL, so admin changes
 * apply within seconds without a restart and without a DB hit per request.
 */
@Injectable()
export class PolicyService {
  private engine?: PolicyEngine;
  private loadedAt = 0;
  private loading?: Promise<PolicyEngine>;
  static readonly TTL_MS = 30_000;

  constructor(@Inject(POLICY_STORE) private readonly store: PolicyStore) {}

  async evaluate(principal: Principal, action: Action, resource: Resource, env: Environment): Promise<Decision> {
    const engine = await this.getEngine();
    return engine.evaluate(principal, action, resource, env);
  }

  /** Call after the Admin Panel changes roles or policies. */
  invalidate(): void {
    this.loadedAt = 0;
  }

  private async getEngine(): Promise<PolicyEngine> {
    if (this.engine && Date.now() - this.loadedAt < PolicyService.TTL_MS) return this.engine;
    this.loading ??= this.store
      .load()
      .then((snap) => {
        this.engine = new PolicyEngine(snap);
        this.loadedAt = Date.now();
        return this.engine;
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }
}
