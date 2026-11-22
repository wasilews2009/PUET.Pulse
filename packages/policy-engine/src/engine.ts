import {
  AccountStatus,
  Action,
  BotCode,
  ChannelType,
  CROSS_TENANT_ROLES,
  E2eeMode,
  MemberRole,
  MFA_REQUIRED_ROLES,
  PRIVATE_CHANNEL_TYPES,
  PrincipalKind,
  ResourceType,
  RoleCode,
} from '@puet/shared';
import { evaluateCondition, type ConditionContext } from './conditions';
import { canSeeInDirectory, checkDirectMessage } from './relationships';
import { DEFAULT_PERMISSION_MATRIX } from './matrix';
import type {
  ConfigurablePolicy,
  Decision,
  Environment,
  PermissionMatrix,
  Principal,
  Resource,
  RoleGrant,
} from './types';

/** Administrative actions: the grant's scope must cover the resource. */
const SCOPED_ACTIONS: ReadonlySet<string> = new Set([
  Action.BROADCAST_PUBLISH,
  Action.EMERGENCY_ALERT_SEND,
  Action.STRUCTURE_MANAGE,
  Action.ROLE_ASSIGN,
  Action.POLICY_MANAGE,
  Action.AUDIT_READ,
  Action.CERTIFICATE_ISSUE,
  Action.CERTIFICATE_REVOKE,
  Action.VOTE_MANAGE,
  Action.SYNC_INGEST,
]);

/** Channel administration: needs OWNER/MODERATOR membership or a covering oversight grant. */
const CHANNEL_ADMIN_ACTIONS: ReadonlySet<string> = new Set([
  Action.CHANNEL_UPDATE,
  Action.CHANNEL_ARCHIVE,
  Action.CHANNEL_MODERATE,
  Action.CHANNEL_MEMBERS_MANAGE,
]);

/** Actions that read content of a channel. */
const CHANNEL_READ_ACTIONS: ReadonlySet<string> = new Set([
  Action.CHANNEL_READ,
  Action.MESSAGE_READ,
  Action.FILE_VIEW,
  Action.FILE_DOWNLOAD,
]);

/** Actions that write content into a channel. */
const CHANNEL_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  Action.MESSAGE_SEND,
  Action.FILE_UPLOAD,
  Action.MESSAGE_EDIT,
]);

/** Channel types where only OWNER/MODERATOR may start a poll: broadcasts and collegial bodies. */
const MODERATED_POLL_CHANNELS: ReadonlySet<string> = new Set([
  ChannelType.ANNOUNCEMENT,
  ChannelType.EMERGENCY,
  ChannelType.GOVERNANCE,
]);

/**
 * Channel types where only OWNER/MODERATOR may start a call: broadcasts, collegial bodies
 * (an online meeting is opened by its secretary or chair) and course channels (the lecturer).
 */
const MODERATED_CALL_CHANNELS: ReadonlySet<string> = new Set([
  ChannelType.ANNOUNCEMENT,
  ChannelType.EMERGENCY,
  ChannelType.GOVERNANCE,
  ChannelType.COURSE,
]);

/** Roles whose grants let them oversee non-private channels inside their scope. */
const OVERSIGHT_ROLES: ReadonlySet<string> = new Set([
  RoleCode.SUPER_ADMIN,
  RoleCode.RECTORATE,
  RoleCode.INSTITUTE_DIRECTOR,
  RoleCode.DEPARTMENT_HEAD,
  RoleCode.DORM_COMMANDANT,
]);

/** Channel types where only OWNER/MODERATOR may post. */
const BROADCAST_ONLY_CHANNELS: ReadonlySet<string> = new Set([
  ChannelType.ANNOUNCEMENT,
  ChannelType.EMERGENCY,
]);

const CHANNEL_SCOPED_RESOURCES: ReadonlySet<string> = new Set([
  ResourceType.CHANNEL,
  ResourceType.MESSAGE,
  ResourceType.FILE,
  ResourceType.DOCUMENT,
  ResourceType.VOTE,
  ResourceType.CALL,
]);

export interface PolicyEngineOptions {
  matrix?: PermissionMatrix;
  policies?: readonly ConfigurablePolicy[];
  /** Org units (e.g. HR) whose ADMIN_STAFF may read personal phone numbers. */
  phoneAccessOrgUnitIds?: readonly string[];
}

/** Everything a pseudonym (anonymous appeal) may ever do, whatever a matrix override says. */
const PSEUDONYM_ACTIONS: ReadonlySet<string> = new Set([
  Action.CHANNEL_LIST,
  Action.DEVICE_MANAGE,
  Action.E2EE_KEYS_ACCESS,
  Action.CHANNEL_READ,
  Action.MESSAGE_READ,
  Action.MESSAGE_SEND,
  Action.USER_PROFILE_READ,
]);

const deny = (reason: string, extra: Partial<Decision> = {}): Decision => ({
  allowed: false,
  reason,
  ...extra,
});

export function isPrivateResource(resource: Resource): boolean {
  return (
    resource.confidential === true ||
    resource.e2eeMode === E2eeMode.MANDATORY ||
    (resource.channelType !== undefined && PRIVATE_CHANNEL_TYPES.includes(resource.channelType))
  );
}

export function tenantCovers(grant: RoleGrant, tenantId: string): boolean {
  if (grant.tenantId === '*') return CROSS_TENANT_ROLES.includes(grant.role);
  return grant.tenantId === tenantId;
}

/** Every key set on the grant's scope must equal the same key on the resource. */
export function scopeCovers(grant: RoleGrant, resource: Resource): boolean {
  if (!tenantCovers(grant, resource.tenantId)) return false;
  const scope = grant.scope;
  if (!scope) return true;
  const keys = ['instituteId', 'departmentId', 'orgUnitId', 'dormitoryId'] as const;
  return keys.every((k) => scope[k] === undefined || scope[k] === resource[k]);
}

/**
 * Zero-trust policy decision point. Pure and synchronous: the caller resolves
 * every fact (membership, ownership, target attributes) from the database first.
 *
 * Order of evaluation (first deny wins, default is deny):
 *  1. account status and grant expiry
 *  2. MFA for privileged roles
 *  3. admin-configured DENY policies
 *  4. RBAC (permission matrix + tenant/scope coverage) or admin ALLOW policy
 *  5. hard guardrails (membership/IDOR, privacy, minors, DM rules, DLP)
 */
export class PolicyEngine {
  private readonly matrix: PermissionMatrix;
  private readonly policies: readonly ConfigurablePolicy[];
  private readonly phoneAccessOrgUnitIds: readonly string[];

  constructor(options: PolicyEngineOptions = {}) {
    this.matrix = options.matrix ?? DEFAULT_PERMISSION_MATRIX;
    this.policies = [...(options.policies ?? [])]
      .filter((p) => p.enabled !== false)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    this.phoneAccessOrgUnitIds = options.phoneAccessOrgUnitIds ?? [];
  }

  evaluate(principal: Principal, action: Action, resource: Resource, env: Environment): Decision {
    // 1. Account status and grant expiry
    if (principal.status !== AccountStatus.ACTIVE) return deny('principal.inactive');
    const grants = principal.roles.filter(
      (g) => g.expiresAt === undefined || g.expiresAt.getTime() > env.now.getTime(),
    );
    if (grants.length === 0) return deny('rbac.no_active_grant');

    // 2. MFA for privileged roles: the whole session is untrusted until verified
    if (!principal.mfaVerified && grants.some((g) => MFA_REQUIRED_ROLES.includes(g.role))) {
      return deny('mfa.required');
    }

    // 3. Admin-configured DENY policies
    const ctx = this.conditionContext(principal, action, resource, env);
    const matching = this.policies.filter((p) => this.policyMatches(p, action, resource, ctx));
    const denyPolicy = matching.find((p) => p.effect === 'deny');
    if (denyPolicy) return deny('policy.deny', { policyId: denyPolicy.id });

    // 4. RBAC
    const effectiveTenant =
      resource.type === ResourceType.USER || resource.type === ResourceType.DIRECTORY
        ? principal.tenantId
        : resource.tenantId;
    let candidates = grants.filter(
      (g) => this.matrixAllows(g, action) && tenantCovers(g, effectiveTenant),
    );
    if (SCOPED_ACTIONS.has(action)) candidates = candidates.filter((g) => scopeCovers(g, resource));

    const viaMembership =
      CHANNEL_ADMIN_ACTIONS.has(action) &&
      (resource.memberRole === MemberRole.OWNER || resource.memberRole === MemberRole.MODERATOR);
    const allowPolicy = matching.find((p) => p.effect === 'allow');

    if (candidates.length === 0 && !viaMembership && !allowPolicy) {
      return deny('rbac.denied');
    }

    // 5. Hard guardrails. Admin ALLOW policies cannot skip these.
    const guard = this.guardrails(principal, action, resource, env, grants, candidates);
    if (guard) return guard;

    return {
      allowed: true,
      reason: candidates.length > 0 ? 'rbac.allow' : viaMembership ? 'membership.allow' : 'policy.allow',
      ...(candidates[0] ? { grant: candidates[0] } : {}),
      ...(candidates.length === 0 && !viaMembership && allowPolicy ? { policyId: allowPolicy.id } : {}),
    };
  }

  /** Convenience wrapper. */
  can(principal: Principal, action: Action, resource: Resource, env: Environment): boolean {
    return this.evaluate(principal, action, resource, env).allowed;
  }

  private matrixAllows(grant: RoleGrant, action: Action): boolean {
    const actions = this.matrix[grant.role];
    return !!actions && (actions.includes('*') || actions.includes(action));
  }

  private policyMatches(
    policy: ConfigurablePolicy,
    action: Action,
    resource: Resource,
    ctx: ConditionContext,
  ): boolean {
    if (policy.tenantId && policy.tenantId !== resource.tenantId) return false;
    if (!policy.actions.includes('*') && !policy.actions.includes(action)) return false;
    if (
      policy.resourceTypes &&
      !policy.resourceTypes.includes('*') &&
      !policy.resourceTypes.includes(resource.type)
    ) {
      return false;
    }
    try {
      return evaluateCondition(policy.condition, ctx);
    } catch {
      // A broken rule must never grant access. A broken deny rule denies.
      return policy.effect === 'deny';
    }
  }

  private conditionContext(
    principal: Principal,
    action: Action,
    resource: Resource,
    env: Environment,
  ): ConditionContext {
    return {
      principal: { ...principal, roleCodes: principal.roles.map((r) => r.role) },
      action,
      resource,
      env: {
        ...env,
        hour: env.now.getUTCHours(),
        weekday: env.now.getUTCDay(),
      },
    };
  }

  private guardrails(
    principal: Principal,
    action: Action,
    resource: Resource,
    env: Environment,
    grants: RoleGrant[],
    candidates: RoleGrant[],
  ): Decision | null {
    // Machine principals only ingest sync data, and only machines may do so.
    if ((principal.kind === PrincipalKind.SERVICE_BOT) !== (action === Action.SYNC_INGEST)) {
      return deny('principal.kind_mismatch');
    }

    // Pseudonyms of anonymous appeals: their own devices and keys, and trust rooms they are in. Nothing else.
    if (principal.kind === PrincipalKind.PSEUDONYM) {
      if (!PSEUDONYM_ACTIONS.has(action)) return deny('pseudonym.scope');
      if (CHANNEL_SCOPED_RESOURCES.has(resource.type) && resource.channelType !== ChannelType.TRUST_ROOM) return deny('pseudonym.scope');
    }
    // Anonymous appeals are opened by people, never by a pseudonym, guest or machine.
    if (action === Action.TRUST_INTAKE && principal.kind !== PrincipalKind.STAFF && principal.kind !== PrincipalKind.STUDENT) {
      return deny('trust.intake_people_only');
    }

    // Own-account resources (settings, devices, key backup) belong to exactly one user.
    if (resource.type === ResourceType.SELF || resource.type === ResourceType.DEVICE) {
      if (!resource.ownerId || resource.ownerId !== principal.userId) return deny('ownership.required');
    }

    // Guests: complete isolation from the internal directory and service chats.
    if (principal.kind === PrincipalKind.GUEST) {
      if (
        resource.type === ResourceType.USER ||
        resource.type === ResourceType.DIRECTORY ||
        action === Action.DM_START
      ) {
        return deny('guest.isolation');
      }
      if (
        CHANNEL_SCOPED_RESOURCES.has(resource.type) &&
        resource.channelType !== ChannelType.GUEST_SPACE
      ) {
        return deny('guest.isolation');
      }
    }

    if (CHANNEL_SCOPED_RESOURCES.has(resource.type)) {
      const channel = this.channelGuardrails(principal, action, resource, env, candidates);
      if (channel) return channel;
    }

    const consultation = this.consultationGuardrails(principal, action, resource);
    if (consultation !== undefined) return consultation;

    const services = this.serviceGuardrails(principal, action, resource, grants);
    if (services !== undefined) return services;

    switch (action) {
      case Action.DM_START: {
        if (!resource.target) return deny('dm.target_required');
        const reason = checkDirectMessage(principal, resource.target);
        return reason ? deny(reason) : null;
      }
      case Action.DIRECTORY_SEARCH:
        // Per-result filtering happens with canSeeInDirectory(); the search itself is allowed.
        return null;
      case Action.USER_PROFILE_READ: {
        if (!resource.target) return deny('user.target_required');
        if (resource.target.userId === principal.userId) return null;
        return canSeeInDirectory(principal, resource.target) ? null : deny('directory.hidden');
      }
      case Action.USER_PHONE_READ: {
        if (!resource.target) return deny('user.target_required');
        if (resource.target.userId === principal.userId) return null;
        const hrAccess =
          resource.target.tenantId === principal.tenantId &&
          grants.some((g) => g.role === RoleCode.ADMIN_STAFF) &&
          principal.orgUnitIds.some((id) => this.phoneAccessOrgUnitIds.includes(id));
        return hrAccess ? null : deny('privacy.phone_hidden');
      }
      case Action.USER_DORM_ROOM_READ: {
        if (!resource.target) return deny('user.target_required');
        if (resource.target.userId === principal.userId) return null;
        const commandant = grants.some(
          (g) =>
            g.role === RoleCode.DORM_COMMANDANT &&
            g.tenantId === resource.target!.tenantId &&
            g.scope?.dormitoryId !== undefined &&
            g.scope.dormitoryId === resource.target!.dormitoryId,
        );
        return commandant ? null : deny('privacy.dorm_room_hidden');
      }
      default:
        return null;
    }
  }

  /**
   * Consultation slots. Returns undefined when the action is not about consultations.
   * Booking follows the DM rules towards the host (a student books a lecturer only with a shared
   * course this semester, minors stay inside their tenant, nobody books the Rectorate).
   */
  private consultationGuardrails(principal: Principal, action: Action, resource: Resource): Decision | null | undefined {
    if (action === Action.CONSULTATION_HOST) {
      if (resource.type !== ResourceType.SELF) return deny('resource.type_mismatch');
      return principal.kind === PrincipalKind.STAFF ? null : deny('consultation.staff_only');
    }
    if (action === Action.CONSULTATION_BOOK && resource.type === ResourceType.SELF) return null;
    if (resource.type !== ResourceType.CONSULTATION) {
      return action === Action.CONSULTATION_BOOK || action === Action.CONSULTATION_MANAGE
        ? deny('resource.type_mismatch')
        : undefined;
    }
    const isHost = resource.ownerId !== undefined && resource.ownerId === principal.userId;
    switch (action) {
      case Action.CONSULTATION_MANAGE:
        return isHost ? null : deny('ownership.required');
      case Action.CONSULTATION_BOOK: {
        if (isHost) return deny('consultation.own_slot');
        // Holding a booking: the student may always see and cancel it.
        if (resource.isBooked) return null;
        if (!resource.target) return deny('consultation.host_required');
        const reason = checkDirectMessage(principal, resource.target);
        if (reason) return deny(reason);
        if (resource.courseOfferingId && !principal.activeCourseOfferingIds.includes(resource.courseOfferingId)) {
          return deny('consultation.course_only');
        }
        return null;
      }
      case Action.CALL_JOIN:
        return isHost || resource.isBooked ? null : deny('membership.required');
      default:
        return deny('resource.type_mismatch');
    }
  }

  /**
   * Phase 8 corporate bots and their services. Returns undefined when the action is not about them.
   * Each bot serves the people its office serves; tickets are visible to their requester and to the
   * handlers of the unit (or the commandant of the dormitory) they are routed to.
   */
  private serviceGuardrails(
    principal: Principal,
    action: Action,
    resource: Resource,
    grants: RoleGrant[],
  ): Decision | null | undefined {
    const person = principal.kind === PrincipalKind.STAFF || principal.kind === PrincipalKind.STUDENT;
    const own = resource.ownerId !== undefined && resource.ownerId === principal.userId;
    switch (action) {
      case Action.BOT_USE: {
        // Listing one's own bots; each bot is then decided on its own BOT resource.
        if (resource.type === ResourceType.SELF) return null;
        if (resource.type !== ResourceType.BOT) return deny('resource.type_mismatch');
        switch (resource.botCode) {
          case BotCode.DEANERY:
            return principal.kind === PrincipalKind.STUDENT ? null : deny('bot.not_available');
          case BotCode.SCHEDULE:
          case BotCode.SERVICE_DESK:
            return person ? null : deny('bot.not_available');
          case BotCode.CHANCELLERY:
            return principal.kind === PrincipalKind.STAFF ? null : deny('bot.not_available');
          case BotCode.ADMISSIONS:
            // Applicants are guests of the Admissions Office; everyone may ask about the rules.
            return null;
          default:
            return deny('bot.unknown');
        }
      }
      case Action.ADMISSIONS_KB_MANAGE: {
        if (resource.type !== ResourceType.BOT || resource.botCode !== BotCode.ADMISSIONS) {
          return deny('resource.type_mismatch');
        }
        // Only staff of the tenant's Admissions Office maintain the rules the consultant cites.
        if (!resource.orgUnitId || !principal.orgUnitIds.includes(resource.orgUnitId)) return deny('admissions.office_only');
        return null;
      }
      case Action.DEANERY_USE: {
        if (principal.kind !== PrincipalKind.STUDENT) return deny('deanery.students_only');
        if (resource.type === ResourceType.SELF) return null;
        if (resource.type !== ResourceType.STUDENT_DOCUMENT) return deny('resource.type_mismatch');
        return own ? null : deny('ownership.required');
      }
      case Action.SCHEDULE_READ:
        if (resource.type !== ResourceType.SELF) return deny('resource.type_mismatch');
        return person ? null : deny('schedule.not_available');
      case Action.TICKET_CREATE:
        if (resource.type !== ResourceType.SELF) return deny('resource.type_mismatch');
        return person ? null : deny('ticket.not_available');
      case Action.TICKET_READ:
      case Action.TICKET_UPDATE:
      case Action.TICKET_HANDLE: {
        if (action === Action.TICKET_HANDLE && resource.type === ResourceType.SELF) {
          // The queue itself: the query returns only tickets routed to the caller's units.
          return principal.kind === PrincipalKind.STAFF ? null : deny('ticket.handlers_only');
        }
        if (resource.type !== ResourceType.TICKET) return deny('resource.type_mismatch');
        const commandant =
          resource.dormitoryId !== undefined &&
          grants.some(
            (g) =>
              g.role === RoleCode.DORM_COMMANDANT &&
              g.tenantId === resource.tenantId &&
              g.scope?.dormitoryId !== undefined &&
              g.scope.dormitoryId === resource.dormitoryId,
          );
        const handler = principal.kind === PrincipalKind.STAFF && (resource.isHandler === true || commandant);
        if (action === Action.TICKET_HANDLE) return handler ? null : deny('ticket.not_handler');
        return own || handler ? null : deny('ownership.required');
      }
      default:
        return undefined;
    }
  }

  private channelGuardrails(
    principal: Principal,
    action: Action,
    resource: Resource,
    env: Environment,
    candidates: RoleGrant[],
  ): Decision | null {
    const isPrivate = isPrivateResource(resource);
    const isModerator =
      resource.isMember === true &&
      (resource.memberRole === MemberRole.OWNER || resource.memberRole === MemberRole.MODERATOR);
    const oversight =
      !isPrivate &&
      candidates.some((g) => OVERSIGHT_ROLES.has(g.role) && scopeCovers(g, resource));

    if (CHANNEL_ADMIN_ACTIONS.has(action)) {
      if (isModerator || oversight) {
        if (resource.archived && action !== Action.CHANNEL_ARCHIVE && action !== Action.CHANNEL_READ) {
          return deny('channel.archived');
        }
        return null;
      }
      return deny('channel.not_moderator');
    }

    // Approvers of a document's approval route may read and sign that one file.
    const approverOfFile = resource.type === ResourceType.FILE && resource.isApprover === true;

    if (CHANNEL_READ_ACTIONS.has(action)) {
      if (action === Action.FILE_DOWNLOAD && resource.confidential) {
        return deny('dlp.view_only');
      }
      if (resource.isMember) return null;
      if (approverOfFile && (action === Action.FILE_VIEW || action === Action.FILE_DOWNLOAD)) return null;
      // Exceptional metadata access to a private room needs a recorded commission decision.
      if (
        isPrivate &&
        action === Action.CHANNEL_READ &&
        env.committeeDecisionId &&
        candidates.some((g) => g.role === RoleCode.SUPER_ADMIN)
      ) {
        return null;
      }
      return oversight ? null : deny('membership.required');
    }

    if (CHANNEL_WRITE_ACTIONS.has(action)) {
      if (!resource.isMember) return deny('membership.required');
      if (resource.archived) return deny('channel.archived');
      if (resource.memberRole === MemberRole.READ_ONLY) return deny('channel.read_only');
      if (
        resource.channelType &&
        BROADCAST_ONLY_CHANNELS.has(resource.channelType) &&
        !isModerator
      ) {
        return deny('channel.broadcast_only');
      }
      if (action === Action.MESSAGE_EDIT && resource.ownerId !== principal.userId) {
        return deny('ownership.required');
      }
      return null;
    }

    if (action === Action.MESSAGE_DELETE) {
      if (!resource.isMember) return deny('membership.required');
      if (resource.archived) return deny('channel.archived');
      if (resource.ownerId === principal.userId || isModerator) return null;
      return deny('ownership.required');
    }

    if (action === Action.BROADCAST_PUBLISH || action === Action.EMERGENCY_ALERT_SEND) {
      return resource.archived ? deny('channel.archived') : null;
    }

    if (action === Action.FILE_ANNOTATE) {
      if (resource.type !== ResourceType.FILE) return deny('resource.type_mismatch');
      if (!resource.isMember && !approverOfFile) return deny('membership.required');
      return resource.archived ? deny('channel.archived') : null;
    }

    if (action === Action.DOCUMENT_SIGN) {
      if (resource.type !== ResourceType.FILE) return deny('resource.type_mismatch');
      if (approverOfFile) return null;
      if (!resource.isMember) return deny('membership.required');
      if (resource.archived) return deny('channel.archived');
      if (resource.memberRole === MemberRole.READ_ONLY) return deny('channel.read_only');
      return null;
    }

    if (action === Action.APPROVAL_ROUTE_CREATE) {
      if (resource.type !== ResourceType.FILE) return deny('resource.type_mismatch');
      if (!resource.isMember) return deny('membership.required');
      if (resource.ownerId !== principal.userId) return deny('ownership.required');
      return resource.archived ? deny('channel.archived') : null;
    }

    // Phase 6. Polls live in channels: membership decides; broadcasts and collegial bodies
    // are moderated, but every member may vote and confirm directives there.
    if (action === Action.POLL_CREATE) {
      if (resource.type !== ResourceType.CHANNEL) return deny('resource.type_mismatch');
      if (!resource.isMember) return deny('membership.required');
      if (resource.archived) return deny('channel.archived');
      if (resource.memberRole === MemberRole.READ_ONLY) return deny('channel.read_only');
      if (resource.channelType && MODERATED_POLL_CHANNELS.has(resource.channelType) && !isModerator) {
        return deny('channel.not_moderator');
      }
      return null;
    }

    if (action === Action.VOTE_CAST) {
      if (resource.type !== ResourceType.VOTE) return deny('resource.type_mismatch');
      if (!resource.isMember) return deny('membership.required');
      if (resource.archived) return deny('channel.archived');
      if (resource.memberRole === MemberRole.READ_ONLY) return deny('channel.read_only');
      return null;
    }

    if (action === Action.POLL_MANAGE) {
      if (resource.type !== ResourceType.VOTE) return deny('resource.type_mismatch');
      if (!resource.isMember) return deny('membership.required');
      if (resource.archived) return deny('channel.archived');
      return resource.ownerId === principal.userId || isModerator ? null : deny('ownership.required');
    }

    if (action === Action.MESSAGE_ACK) {
      if (resource.type !== ResourceType.MESSAGE) return deny('resource.type_mismatch');
      return resource.isMember ? null : deny('membership.required');
    }

    // Phase 7. Calls: media travels through the on-premise SFU, so rooms whose content must be
    // end-to-end encrypted get no calls until media E2EE is designed (like attachments).
    if (action === Action.CALL_START) {
      if (resource.type !== ResourceType.CHANNEL) return deny('resource.type_mismatch');
      if (!resource.isMember) return deny('membership.required');
      if (resource.archived) return deny('channel.archived');
      if (resource.memberRole === MemberRole.READ_ONLY) return deny('channel.read_only');
      if (resource.e2eeMode === E2eeMode.MANDATORY) return deny('call.e2ee_unavailable');
      if (resource.channelType && MODERATED_CALL_CHANNELS.has(resource.channelType) && !isModerator) {
        return deny('channel.not_moderator');
      }
      return null;
    }

    if (action === Action.CALL_JOIN || action === Action.CALL_MANAGE) {
      if (resource.type !== ResourceType.CALL) return deny('resource.type_mismatch');
      // Channel calls: channel members. Consultation calls: the host and booked students.
      if (!resource.isMember) return deny('membership.required');
      if (resource.archived) return deny('channel.archived');
      if (resource.e2eeMode === E2eeMode.MANDATORY) return deny('call.e2ee_unavailable');
      if (action === Action.CALL_MANAGE && resource.ownerId !== principal.userId && !isModerator) {
        return deny('ownership.required');
      }
      return null;
    }

    // Only an approver named on the file's route decides; channel membership is not enough.
    if (action === Action.DOCUMENT_APPROVE) {
      if (resource.type !== ResourceType.FILE) return deny('resource.type_mismatch');
      return approverOfFile ? null : deny('approval.not_approver');
    }

    return null;
  }
}
