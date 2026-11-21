import {
  AccountStatus,
  ChannelType,
  E2eeMode,
  MemberRole,
  PrincipalKind,
  ResourceType,
  RoleCode,
} from '@puet/shared';
import type { Environment, Principal, Resource, TargetUserFacts } from '../src';

export const T_MAIN = 'tenant-puet-main';
export const T_LYCEUM = 'tenant-puet-lyceum';
export const T_COLLEGE = 'tenant-college-poltava';

export const INST_DAY = 'inst-daytime';
export const INST_INTL = 'inst-international';
export const DEPT_CS = 'dept-computer-science';
export const DEPT_LAW = 'dept-law';
export const DORM_1 = 'dorm-1';
export const DORM_2 = 'dorm-2';
export const OU_HR = 'ou-hr';

export const NOW = new Date('2026-11-21T10:00:00Z');
export const env = (over: Partial<Environment> = {}): Environment => ({ now: NOW, ...over });

export function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: 'u-student',
    tenantId: T_MAIN,
    kind: PrincipalKind.STUDENT,
    status: AccountStatus.ACTIVE,
    roles: [{ role: RoleCode.STUDENT, tenantId: T_MAIN }],
    isMinor: false,
    mfaVerified: false,
    instituteIds: [INST_DAY],
    departmentIds: [],
    orgUnitIds: [],
    academicGroupIds: ['grp-ki-21'],
    activeCourseOfferingIds: ['co-algorithms'],
    ...over,
  };
}

export const student = (over: Partial<Principal> = {}) => principal(over);

export const lecturer = (over: Partial<Principal> = {}) =>
  principal({
    userId: 'u-lecturer',
    kind: PrincipalKind.STAFF,
    roles: [{ role: RoleCode.LECTURER, tenantId: T_MAIN }],
    departmentIds: [DEPT_CS],
    academicGroupIds: [],
    activeCourseOfferingIds: ['co-algorithms'],
    ...over,
  });

export const superAdmin = (over: Partial<Principal> = {}) =>
  principal({
    userId: 'u-admin',
    kind: PrincipalKind.STAFF,
    roles: [{ role: RoleCode.SUPER_ADMIN, tenantId: '*' }],
    mfaVerified: true,
    academicGroupIds: [],
    activeCourseOfferingIds: [],
    ...over,
  });

export const lyceumPupil = (over: Partial<Principal> = {}) =>
  principal({
    userId: 'u-pupil',
    tenantId: T_LYCEUM,
    isMinor: true,
    roles: [{ role: RoleCode.STUDENT, tenantId: T_LYCEUM }],
    instituteIds: [],
    academicGroupIds: ['lyc-10a'],
    activeCourseOfferingIds: ['co-lyc-math'],
    ...over,
  });

export function target(over: Partial<TargetUserFacts> = {}): TargetUserFacts {
  return {
    userId: 'u-target',
    tenantId: T_MAIN,
    kind: PrincipalKind.STUDENT,
    status: AccountStatus.ACTIVE,
    isMinor: false,
    roles: [RoleCode.STUDENT],
    instituteIds: [INST_DAY],
    academicGroupIds: ['grp-other'],
    activeCourseOfferingIds: [],
    ...over,
  };
}

export const userResource = (t: TargetUserFacts): Resource => ({
  type: ResourceType.USER,
  id: t.userId,
  tenantId: t.tenantId,
  target: t,
});

export function channel(over: Partial<Resource> = {}): Resource {
  return {
    type: ResourceType.CHANNEL,
    id: 'ch-course-algorithms',
    tenantId: T_MAIN,
    channelType: ChannelType.COURSE,
    e2eeMode: E2eeMode.DISABLED,
    isMember: true,
    memberRole: MemberRole.MEMBER,
    instituteId: INST_DAY,
    departmentId: DEPT_CS,
    ...over,
  };
}
