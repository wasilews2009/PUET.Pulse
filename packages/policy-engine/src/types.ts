import type {
  AccountStatus,
  Action,
  ChannelType,
  E2eeMode,
  MemberRole,
  PrincipalKind,
  ResourceType,
  RoleCode,
} from '@puet/shared';

/** Optional narrowing of a role grant inside its tenant. Empty scope = whole tenant. */
export interface GrantScope {
  instituteId?: string;
  departmentId?: string;
  orgUnitId?: string;
  dormitoryId?: string;
}

export interface RoleGrant {
  role: RoleCode;
  /** Tenant the grant is valid in. `'*'` only for CROSS_TENANT_ROLES. */
  tenantId: string;
  scope?: GrantScope;
  /** TTL for guests and temporary duties. Expired grants are ignored. */
  expiresAt?: Date;
}

/**
 * The authenticated subject. Built server-side from the session and the
 * corporate directory. Never built from client-supplied fields.
 */
export interface Principal {
  userId: string;
  tenantId: string;
  kind: PrincipalKind;
  status: AccountStatus;
  roles: RoleGrant[];
  isMinor: boolean;
  /** True when the current session passed TOTP / WebAuthn. */
  mfaVerified: boolean;
  instituteIds: string[];
  departmentIds: string[];
  orgUnitIds: string[];
  academicGroupIds: string[];
  dormitoryId?: string;
  /** Course offerings of the *current* semester (taught or enrolled). */
  activeCourseOfferingIds: string[];
}

/** Facts about a user who is the target of an action (DM, profile, directory). */
export interface TargetUserFacts {
  userId: string;
  tenantId: string;
  kind: PrincipalKind;
  status: AccountStatus;
  isMinor: boolean;
  roles: RoleCode[];
  instituteIds: string[];
  academicGroupIds: string[];
  dormitoryId?: string;
  activeCourseOfferingIds: string[];
}

/**
 * Resource descriptor. Ownership and membership facts MUST come from a
 * server-side lookup keyed by the resource id (see ResourceResolver in the API),
 * never from the request body. This is what prevents IDOR.
 */
export interface Resource {
  type: ResourceType;
  id?: string;
  tenantId: string;
  ownerId?: string;
  /** Whether the principal is an active member of the resource's channel. */
  isMember?: boolean;
  memberRole?: MemberRole;
  channelType?: ChannelType;
  e2eeMode?: E2eeMode;
  confidential?: boolean;
  archived?: boolean;
  instituteId?: string;
  departmentId?: string;
  orgUnitId?: string;
  dormitoryId?: string;
  courseOfferingId?: string;
  target?: TargetUserFacts;
}

export interface Environment {
  now: Date;
  ip?: string;
  /** Id of a recorded commission decision that authorizes exceptional access. */
  committeeDecisionId?: string;
}

export interface Decision {
  allowed: boolean;
  /** Stable machine-readable reason, written to the audit log. */
  reason: string;
  policyId?: string;
  /** Role grant that authorized the action, when allowed via RBAC. */
  grant?: RoleGrant;
}

/** Role -> actions. `'*'` grants every action (still subject to guardrails). */
export type PermissionMatrix = Partial<Record<RoleCode, readonly (Action | '*')[]>>;

export type Operand =
  | { var: string }
  | string
  | number
  | boolean
  | null
  | Operand[];

export type Condition =
  | boolean
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { eq: [Operand, Operand] }
  | { neq: [Operand, Operand] }
  | { in: [Operand, Operand] }
  | { intersects: [Operand, Operand] }
  | { gt: [Operand, Operand] }
  | { gte: [Operand, Operand] }
  | { lt: [Operand, Operand] }
  | { lte: [Operand, Operand] }
  | { exists: Operand };

/**
 * Admin-configurable ABAC rule (stored as JSON in `abac_policies`).
 * `deny` rules always win. `allow` rules can add a permission the matrix lacks,
 * but can never bypass a hard guardrail.
 */
export interface ConfigurablePolicy {
  id: string;
  description?: string;
  effect: 'allow' | 'deny';
  actions: readonly (Action | '*')[];
  resourceTypes?: readonly (ResourceType | '*')[];
  /** Restrict the rule to one tenant. Omit for all tenants. */
  tenantId?: string;
  condition: Condition;
  priority?: number;
  enabled?: boolean;
}
