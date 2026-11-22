import { AccountStatus, PrincipalKind, RoleCode } from '@puet/shared';
import type { Principal, TargetUserFacts } from './types';

const ACADEMIC_STAFF_ROLES: readonly RoleCode[] = [RoleCode.LECTURER, RoleCode.DEPARTMENT_HEAD];

const intersects = (a: readonly string[], b: readonly string[]) => a.some((x) => b.includes(x));

/**
 * Minor protection (PUET_LYCEUM pupils and anyone under 18).
 * A minor and another person may interact only inside the same tenant, and only
 * when the other person is staff of that tenant or shares an academic group.
 */
function minorContactAllowed(principal: Principal, target: TargetUserFacts): boolean {
  if (principal.tenantId !== target.tenantId) return false;
  if (principal.kind === PrincipalKind.STAFF || target.kind === PrincipalKind.STAFF) return true;
  return intersects(principal.academicGroupIds, target.academicGroupIds);
}

/**
 * Whether `target` may appear in `principal`'s directory search results or
 * profile view. Use it to filter every directory query result.
 */
export function canSeeInDirectory(principal: Principal, target: TargetUserFacts): boolean {
  if (principal.kind === PrincipalKind.GUEST) return false;
  if (target.userId === principal.userId) return true;
  if (target.status !== AccountStatus.ACTIVE) return false;
  // Anonymous appeals: the pseudonym sees staff of its tenant (the officers), and only
  // staff of that tenant see the pseudonym's card (an alias, nothing else).
  if (principal.kind === PrincipalKind.PSEUDONYM || target.kind === PrincipalKind.PSEUDONYM) {
    const other = principal.kind === PrincipalKind.PSEUDONYM ? target : principal;
    return principal.tenantId === target.tenantId && other.kind === PrincipalKind.STAFF;
  }
  if (target.isMinor || principal.isMinor) return minorContactAllowed(principal, target);
  if (target.kind === PrincipalKind.GUEST) return principal.kind === PrincipalKind.STAFF;
  if (principal.tenantId !== target.tenantId) {
    return principal.kind === PrincipalKind.STAFF && target.kind === PrincipalKind.STAFF;
  }
  return true;
}

/**
 * Rules for starting a direct conversation. Returns a deny reason, or null when allowed.
 */
export function checkDirectMessage(principal: Principal, target: TargetUserFacts): string | null {
  if (target.userId === principal.userId) return 'dm.self';
  if (principal.kind === PrincipalKind.PSEUDONYM || target.kind === PrincipalKind.PSEUDONYM) return 'pseudonym.no_dm';
  if (target.status !== AccountStatus.ACTIVE) return 'dm.target_inactive';
  if (principal.kind === PrincipalKind.GUEST) return 'guest.isolation';

  if (target.kind === PrincipalKind.GUEST) {
    return principal.kind === PrincipalKind.STAFF ? null : 'dm.guest_target';
  }

  if (principal.isMinor || target.isMinor) {
    if (!minorContactAllowed(principal, target)) return 'minor.protection';
  }

  if (principal.tenantId !== target.tenantId) {
    const bothStaff = principal.kind === PrincipalKind.STAFF && target.kind === PrincipalKind.STAFF;
    if (!bothStaff) return 'tenant.isolation';
  }

  if (principal.kind === PrincipalKind.STUDENT && target.kind === PrincipalKind.STAFF) {
    // Trust services (Ombudsman, Psychological Service) must always be reachable.
    if (target.roles.includes(RoleCode.TRUST_SERVICE_OFFICER)) return null;
    if (target.roles.includes(RoleCode.RECTORATE)) return 'dm.student_to_rectorate';
    if (target.roles.some((r) => ACADEMIC_STAFF_ROLES.includes(r))) {
      if (!intersects(principal.activeCourseOfferingIds, target.activeCourseOfferingIds)) {
        return 'dm.no_shared_course';
      }
    }
  }

  return null;
}
