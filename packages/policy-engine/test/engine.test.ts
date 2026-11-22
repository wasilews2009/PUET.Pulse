import { describe, expect, it } from 'vitest';
import {
  AccountStatus,
  Action,
  ChannelType,
  E2eeMode,
  MemberRole,
  PrincipalKind,
  ResourceType,
  RoleCode,
} from '@puet/shared';
import { PolicyEngine, canSeeInDirectory, evaluateCondition, validateCondition, type Resource } from '../src';
import {
  DEPT_CS,
  DEPT_LAW,
  DORM_1,
  DORM_2,
  INST_DAY,
  INST_INTL,
  NOW,
  OU_HR,
  T_COLLEGE,
  T_LYCEUM,
  T_MAIN,
  channel,
  env,
  lecturer,
  lyceumPupil,
  principal,
  student,
  superAdmin,
  target,
  userResource,
} from './fixtures';

const engine = new PolicyEngine({ phoneAccessOrgUnitIds: [OU_HR] });

describe('account status, TTL and MFA', () => {
  it('denies everything for an offboarded account', () => {
    const p = student({ status: AccountStatus.OFFBOARDED });
    expect(engine.evaluate(p, Action.MESSAGE_READ, channel(), env()).reason).toBe('principal.inactive');
  });

  it('ignores expired guest grants', () => {
    const guest = principal({
      kind: PrincipalKind.GUEST,
      roles: [{ role: RoleCode.GUEST, tenantId: T_MAIN, expiresAt: new Date(NOW.getTime() - 1000) }],
    });
    const space = channel({ channelType: ChannelType.GUEST_SPACE });
    expect(engine.evaluate(guest, Action.MESSAGE_READ, space, env()).reason).toBe('rbac.no_active_grant');
  });

  it('requires MFA for privileged roles', () => {
    const admin = superAdmin({ mfaVerified: false });
    const res = { type: ResourceType.STRUCTURE, tenantId: T_MAIN };
    expect(engine.evaluate(admin, Action.STRUCTURE_MANAGE, res, env()).reason).toBe('mfa.required');
    expect(engine.can(superAdmin(), Action.STRUCTURE_MANAGE, res, env())).toBe(true);
  });
});

describe('IDOR prevention: membership and ownership', () => {
  it('lets a member read their own course channel', () => {
    expect(engine.can(student(), Action.MESSAGE_READ, channel(), env())).toBe(true);
  });

  it('denies a non-member reading another channel by id', () => {
    const other = channel({ id: 'ch-other', isMember: false, memberRole: undefined });
    expect(engine.evaluate(student(), Action.MESSAGE_READ, other, env()).reason).toBe('membership.required');
    expect(engine.can(student(), Action.FILE_DOWNLOAD, { ...other, type: ResourceType.FILE }, env())).toBe(false);
  });

  it('denies posting into a channel the user is not a member of', () => {
    const other = channel({ isMember: false, memberRole: undefined });
    expect(engine.can(student(), Action.MESSAGE_SEND, other, env())).toBe(false);
  });

  it('only lets the author edit a message', () => {
    const msg = { ...channel(), type: ResourceType.MESSAGE, ownerId: 'someone-else' };
    expect(engine.evaluate(student(), Action.MESSAGE_EDIT, msg, env()).reason).toBe('ownership.required');
    expect(engine.can(student(), Action.MESSAGE_EDIT, { ...msg, ownerId: 'u-student' }, env())).toBe(true);
  });

  it('lets the author or a moderator delete a message, nobody else', () => {
    const msg = { ...channel(), type: ResourceType.MESSAGE, ownerId: 'someone-else' };
    expect(engine.can(student(), Action.MESSAGE_DELETE, msg, env())).toBe(false);
    expect(
      engine.can(lecturer(), Action.MESSAGE_DELETE, { ...msg, memberRole: MemberRole.MODERATOR }, env()),
    ).toBe(true);
  });

  it('a lecturer cannot moderate a course channel just by holding the LECTURER role', () => {
    const notMine = channel({ isMember: false, memberRole: undefined });
    expect(engine.evaluate(lecturer(), Action.CHANNEL_MODERATE, notMine, env()).reason).toBe(
      'channel.not_moderator',
    );
  });

  it('a student owner can manage their own private group', () => {
    const own = channel({ channelType: ChannelType.PRIVATE_GROUP, memberRole: MemberRole.OWNER });
    expect(engine.can(student(), Action.CHANNEL_MEMBERS_MANAGE, own, env())).toBe(true);
  });
});

describe('scope (ABAC) for administrative roles', () => {
  const head = (dept: string) =>
    lecturer({
      roles: [{ role: RoleCode.DEPARTMENT_HEAD, tenantId: T_MAIN, scope: { departmentId: dept } }],
    });

  it('a department head moderates channels of their department only', () => {
    const csChannel = channel({ isMember: false, memberRole: undefined, departmentId: DEPT_CS });
    const lawChannel = channel({ isMember: false, memberRole: undefined, departmentId: DEPT_LAW });
    expect(engine.can(head(DEPT_CS), Action.CHANNEL_MODERATE, csChannel, env())).toBe(true);
    expect(engine.can(head(DEPT_CS), Action.CHANNEL_MODERATE, lawChannel, env())).toBe(false);
  });

  it('an institute director broadcasts only inside their institute', () => {
    const director = lecturer({
      mfaVerified: true,
      roles: [{ role: RoleCode.INSTITUTE_DIRECTOR, tenantId: T_MAIN, scope: { instituteId: INST_DAY } }],
    });
    const own = channel({ channelType: ChannelType.INSTITUTE, instituteId: INST_DAY });
    const other = channel({ channelType: ChannelType.INSTITUTE, instituteId: INST_INTL });
    expect(engine.can(director, Action.BROADCAST_PUBLISH, own, env())).toBe(true);
    expect(engine.can(director, Action.BROADCAST_PUBLISH, other, env())).toBe(false);
  });

  it('isolates tenants: a college lecturer cannot read a PUET_MAIN channel', () => {
    const collegeLecturer = lecturer({
      tenantId: T_COLLEGE,
      roles: [{ role: RoleCode.LECTURER, tenantId: T_COLLEGE }],
    });
    expect(engine.evaluate(collegeLecturer, Action.MESSAGE_READ, channel(), env()).reason).toBe('rbac.denied');
  });

  it('a wildcard tenant grant is ignored for roles that are not cross-tenant', () => {
    const forged = lecturer({ roles: [{ role: RoleCode.LECTURER, tenantId: '*' }] });
    expect(engine.can(forged, Action.MESSAGE_READ, channel({ tenantId: T_LYCEUM }), env())).toBe(false);
  });
});

describe('private and trust-service rooms', () => {
  const trustRoom = channel({
    channelType: ChannelType.TRUST_ROOM,
    e2eeMode: E2eeMode.MANDATORY,
    isMember: false,
    memberRole: undefined,
  });

  it('a super admin cannot read Ombudsman / Psychological Service rooms', () => {
    expect(engine.can(superAdmin(), Action.MESSAGE_READ, trustRoom, env())).toBe(false);
    expect(engine.can(superAdmin(), Action.CHANNEL_MEMBERS_MANAGE, trustRoom, env())).toBe(false);
  });

  it('a commission decision unlocks room metadata only, never messages', () => {
    const e = env({ committeeDecisionId: 'decision-2026-11' });
    expect(engine.can(superAdmin(), Action.CHANNEL_READ, trustRoom, e)).toBe(true);
    expect(engine.can(superAdmin(), Action.MESSAGE_READ, trustRoom, e)).toBe(false);
  });

  it('the rectorate cannot read a DM it is not part of', () => {
    const rector = lecturer({ mfaVerified: true, roles: [{ role: RoleCode.RECTORATE, tenantId: '*' }] });
    const dm = channel({ channelType: ChannelType.DIRECT, isMember: false, memberRole: undefined });
    expect(engine.can(rector, Action.MESSAGE_READ, dm, env())).toBe(false);
  });

  it('confidential documents are view-only (no download)', () => {
    const file = { ...channel({ confidential: true }), type: ResourceType.FILE };
    expect(engine.evaluate(student(), Action.FILE_DOWNLOAD, file, env()).reason).toBe('dlp.view_only');
    expect(engine.can(student(), Action.FILE_VIEW, file, env())).toBe(true);
  });
});

describe('channel state', () => {
  it('denies posting into an archived (end of semester) course channel', () => {
    const archived = channel({ archived: true });
    expect(engine.evaluate(student(), Action.MESSAGE_SEND, archived, env()).reason).toBe('channel.archived');
    expect(engine.can(student(), Action.MESSAGE_READ, archived, env())).toBe(true);
  });

  it('only moderators post into announcement channels', () => {
    const ann = channel({ channelType: ChannelType.ANNOUNCEMENT });
    expect(engine.evaluate(student(), Action.MESSAGE_SEND, ann, env()).reason).toBe('channel.broadcast_only');
  });

  it('only civil protection can send emergency alerts', () => {
    const emergency = channel({ channelType: ChannelType.EMERGENCY, memberRole: MemberRole.OWNER });
    const officer = lecturer({ roles: [{ role: RoleCode.CIVIL_PROTECTION_OFFICER, tenantId: T_MAIN }] });
    expect(engine.can(officer, Action.EMERGENCY_ALERT_SEND, emergency, env())).toBe(true);
    expect(engine.can(lecturer(), Action.EMERGENCY_ALERT_SEND, emergency, env())).toBe(false);
  });
});

describe('direct messages', () => {
  it('a student cannot DM the rectorate', () => {
    const rector = target({ kind: PrincipalKind.STAFF, roles: [RoleCode.RECTORATE] });
    expect(engine.evaluate(student(), Action.DM_START, userResource(rector), env()).reason).toBe(
      'dm.student_to_rectorate',
    );
  });

  it('a student may DM a lecturer only with a shared course this semester', () => {
    const mine = target({ kind: PrincipalKind.STAFF, roles: [RoleCode.LECTURER], activeCourseOfferingIds: ['co-algorithms'] });
    const other = target({ kind: PrincipalKind.STAFF, roles: [RoleCode.LECTURER], activeCourseOfferingIds: ['co-civil-law'] });
    expect(engine.can(student(), Action.DM_START, userResource(mine), env())).toBe(true);
    expect(engine.evaluate(student(), Action.DM_START, userResource(other), env()).reason).toBe(
      'dm.no_shared_course',
    );
  });

  it('a student can always reach trust services', () => {
    const ombudsman = target({ kind: PrincipalKind.STAFF, roles: [RoleCode.TRUST_SERVICE_OFFICER] });
    expect(engine.can(student(), Action.DM_START, userResource(ombudsman), env())).toBe(true);
  });

  it('cannot DM an offboarded user', () => {
    const gone = target({ status: AccountStatus.OFFBOARDED });
    expect(engine.evaluate(student(), Action.DM_START, userResource(gone), env()).reason).toBe('dm.target_inactive');
  });
});

describe('minor protection (PUET_LYCEUM / under 18)', () => {
  const pupilTarget = target({
    userId: 'u-pupil',
    tenantId: T_LYCEUM,
    isMinor: true,
    academicGroupIds: ['lyc-10a'],
  });

  it('an adult university student cannot DM a lyceum pupil', () => {
    expect(engine.evaluate(student(), Action.DM_START, userResource(pupilTarget), env()).reason).toBe(
      'minor.protection',
    );
  });

  it('an adult university student cannot find a lyceum pupil in the directory', () => {
    expect(canSeeInDirectory(student(), pupilTarget)).toBe(false);
    expect(engine.can(student(), Action.USER_PROFILE_READ, userResource(pupilTarget), env())).toBe(false);
  });

  it('a lyceum teacher can DM and find their pupil', () => {
    const teacher = lecturer({ tenantId: T_LYCEUM, roles: [{ role: RoleCode.LECTURER, tenantId: T_LYCEUM }], activeCourseOfferingIds: ['co-lyc-math'] });
    expect(engine.can(teacher, Action.DM_START, userResource(pupilTarget), env())).toBe(true);
    expect(canSeeInDirectory(teacher, pupilTarget)).toBe(true);
  });

  it('a pupil can DM a classmate but not a pupil from another class', () => {
    const classmate = target({ ...pupilTarget, userId: 'u-classmate' });
    const stranger = target({ ...pupilTarget, userId: 'u-stranger', academicGroupIds: ['lyc-11b'] });
    expect(engine.can(lyceumPupil(), Action.DM_START, userResource(classmate), env())).toBe(true);
    expect(engine.can(lyceumPupil(), Action.DM_START, userResource(stranger), env())).toBe(false);
  });

  it('a pupil cannot search the university directory outside the lyceum', () => {
    expect(canSeeInDirectory(lyceumPupil(), target())).toBe(false);
  });

  it('a minor student inside PUET_MAIN is also protected', () => {
    const minorFresher = target({ isMinor: true, academicGroupIds: ['grp-other'] });
    expect(engine.can(student(), Action.DM_START, userResource(minorFresher), env())).toBe(false);
  });
});

describe('privacy of personal data', () => {
  it('hides personal phone numbers from other users', () => {
    expect(engine.evaluate(lecturer(), Action.USER_PHONE_READ, userResource(target()), env()).reason).toBe(
      'privacy.phone_hidden',
    );
  });

  it('lets users see their own phone and HR staff see employee phones', () => {
    const self = target({ userId: 'u-student' });
    expect(engine.can(student(), Action.USER_PHONE_READ, userResource(self), env())).toBe(true);
    const hr = lecturer({ mfaVerified: true, orgUnitIds: [OU_HR], roles: [{ role: RoleCode.ADMIN_STAFF, tenantId: T_MAIN }] });
    expect(engine.can(hr, Action.USER_PHONE_READ, userResource(target()), env())).toBe(true);
  });

  it('only the commandant of the same dormitory sees room numbers', () => {
    const resident = target({ dormitoryId: DORM_1 });
    const commandant = (dorm: string) =>
      lecturer({ roles: [{ role: RoleCode.DORM_COMMANDANT, tenantId: T_MAIN, scope: { dormitoryId: dorm } }] });
    expect(engine.can(commandant(DORM_1), Action.USER_DORM_ROOM_READ, userResource(resident), env())).toBe(true);
    expect(engine.can(commandant(DORM_2), Action.USER_DORM_ROOM_READ, userResource(resident), env())).toBe(false);
    expect(engine.can(lecturer(), Action.USER_DORM_ROOM_READ, userResource(resident), env())).toBe(false);
  });
});

describe('guests', () => {
  const guest = principal({
    userId: 'u-employer',
    kind: PrincipalKind.GUEST,
    roles: [{ role: RoleCode.GUEST, tenantId: T_MAIN, expiresAt: new Date(NOW.getTime() + 86_400_000) }],
    academicGroupIds: [],
  });

  it('can read a guest space they belong to', () => {
    expect(engine.can(guest, Action.MESSAGE_READ, channel({ channelType: ChannelType.GUEST_SPACE }), env())).toBe(true);
  });

  it('is isolated from the directory, DMs and internal channels', () => {
    expect(engine.can(guest, Action.DIRECTORY_SEARCH, { type: ResourceType.DIRECTORY, tenantId: T_MAIN }, env())).toBe(false);
    expect(engine.can(guest, Action.DM_START, userResource(target()), env())).toBe(false);
    expect(engine.can(guest, Action.MESSAGE_READ, channel(), env())).toBe(false);
  });
});

describe('admin-configurable policies', () => {
  it('a deny policy blocks matching requests', () => {
    const e = new PolicyEngine({
      policies: [
        {
          id: 'no-uploads-in-law',
          effect: 'deny',
          actions: [Action.FILE_UPLOAD],
          condition: { eq: [{ var: 'resource.departmentId' }, DEPT_LAW] },
        },
      ],
    });
    expect(e.evaluate(student(), Action.FILE_UPLOAD, channel({ departmentId: DEPT_LAW }), env()).policyId).toBe(
      'no-uploads-in-law',
    );
    expect(e.can(student(), Action.FILE_UPLOAD, channel(), env())).toBe(true);
  });

  it('an allow policy cannot bypass a hard guardrail', () => {
    const e = new PolicyEngine({
      policies: [{ id: 'allow-all', effect: 'allow', actions: ['*'], condition: true }],
    });
    const pupil = target({ tenantId: T_LYCEUM, isMinor: true });
    expect(e.can(student(), Action.DM_START, userResource(pupil), env())).toBe(false);
    const trust = channel({ channelType: ChannelType.TRUST_ROOM, isMember: false, memberRole: undefined });
    expect(e.can(student(), Action.MESSAGE_READ, trust, env())).toBe(false);
  });

  it('a malformed deny policy fails closed', () => {
    const e = new PolicyEngine({
      policies: [{ id: 'broken', effect: 'deny', actions: ['*'], condition: { nope: 1 } as never }],
    });
    expect(e.can(student(), Action.MESSAGE_READ, channel(), env())).toBe(false);
  });

  it('a malformed allow policy grants nothing', () => {
    const e = new PolicyEngine({
      matrix: {},
      policies: [{ id: 'broken', effect: 'allow', actions: ['*'], condition: { nope: 1 } as never }],
    });
    expect(e.can(student(), Action.MESSAGE_READ, channel(), env())).toBe(false);
  });
});

describe('condition evaluator safety', () => {
  it('rejects prototype access', () => {
    expect(() => evaluateCondition({ exists: { var: 'principal.__proto__' } }, { principal: {} })).toThrow();
    expect(() => evaluateCondition({ exists: { var: 'a.constructor' } }, { a: {} })).toThrow();
  });

  it('supports boolean logic and set operators', () => {
    const ctx = { p: { roles: ['STUDENT'], age: 17 } };
    expect(evaluateCondition({ all: [{ in: ['STUDENT', { var: 'p.roles' }] }, { lt: [{ var: 'p.age' }, 18] }] }, ctx)).toBe(true);
    expect(evaluateCondition({ not: { intersects: [{ var: 'p.roles' }, ['GUEST']] } }, ctx)).toBe(true);
  });

  it('validates condition shape for the admin panel', () => {
    expect(validateCondition({ eq: [1, 1] })).toBeNull();
    expect(validateCondition({ eq: [1] })).not.toBeNull();
    expect(validateCondition({ unknownOp: [] })).not.toBeNull();
  });
});

describe('machine principals (ЄДЕБО / HR sync)', () => {
  const bot = principal({
    userId: 'svc-edebo',
    kind: PrincipalKind.SERVICE_BOT,
    roles: [{ role: RoleCode.INTEGRATION, tenantId: T_MAIN }],
    academicGroupIds: [],
  });
  const integration = { type: ResourceType.INTEGRATION, tenantId: T_MAIN };

  it('an integration client may ingest sync data into its own tenant only', () => {
    expect(engine.can(bot, Action.SYNC_INGEST, integration, env())).toBe(true);
    expect(engine.can(bot, Action.SYNC_INGEST, { ...integration, tenantId: T_LYCEUM }, env())).toBe(false);
  });

  it('an integration client cannot read channels or the directory', () => {
    expect(engine.evaluate(bot, Action.MESSAGE_READ, channel(), env()).allowed).toBe(false);
    expect(engine.can(bot, Action.DIRECTORY_SEARCH, { type: ResourceType.DIRECTORY, tenantId: T_MAIN }, env())).toBe(false);
  });

  it('a human cannot call sync endpoints even with a forged INTEGRATION grant', () => {
    const human = superAdmin({ roles: [{ role: RoleCode.INTEGRATION, tenantId: T_MAIN }] });
    expect(engine.evaluate(human, Action.SYNC_INGEST, integration, env()).reason).toBe('principal.kind_mismatch');
  });
});

describe('own-account resources (Phase 3: devices, keys, presence)', () => {
  const self = (ownerId: string) => ({ type: ResourceType.SELF, tenantId: T_MAIN, ownerId });
  const device = (ownerId: string) => ({ type: ResourceType.DEVICE, id: 'dev-1', tenantId: T_MAIN, ownerId });

  it('a user manages their own devices and presence', () => {
    const s = student();
    expect(engine.can(s, Action.DEVICE_MANAGE, device(s.userId), env())).toBe(true);
    expect(engine.can(s, Action.PRESENCE_UPDATE, self(s.userId), env())).toBe(true);
    expect(engine.can(s, Action.CHANNEL_LIST, self(s.userId), env())).toBe(true);
  });

  it("IDOR: nobody can upload keys to or read the inbox of another user's device", () => {
    const s = student();
    expect(engine.evaluate(s, Action.DEVICE_MANAGE, device('u-lecturer'), env()).reason).toBe('ownership.required');
    expect(engine.evaluate(superAdmin(), Action.DEVICE_MANAGE, device(s.userId), env()).reason).toBe(
      'ownership.required',
    );
  });

  it('a self resource without a resolved owner is denied (fail-closed)', () => {
    expect(engine.evaluate(student(), Action.CHANNEL_LIST, { type: ResourceType.SELF, tenantId: T_MAIN }, env()).reason).toBe(
      'ownership.required',
    );
  });

  it('only lecturers and staff manage quiet hours', () => {
    expect(engine.can(lecturer(), Action.QUIET_HOURS_MANAGE, self('u-lecturer'), env())).toBe(true);
    expect(engine.can(student(), Action.QUIET_HOURS_MANAGE, self('u-student'), env())).toBe(false);
  });
});

describe('documents, signatures and approval routes (Phase 4)', () => {
  const file = (over: Record<string, unknown> = {}) => ({ ...channel(over), type: ResourceType.FILE, id: 'f-1' });
  const outsider = (over: Record<string, unknown> = {}) => file({ isMember: false, memberRole: undefined, ...over });

  it('IDOR: a non-member who is not an approver cannot view, sign or annotate a file', () => {
    const s = student();
    expect(engine.evaluate(s, Action.FILE_VIEW, outsider(), env()).reason).toBe('membership.required');
    expect(engine.evaluate(s, Action.DOCUMENT_SIGN, outsider(), env()).reason).toBe('membership.required');
    expect(engine.evaluate(s, Action.FILE_ANNOTATE, outsider(), env()).reason).toBe('membership.required');
  });

  it('an approver named on the route may view and sign the file without channel membership', () => {
    const l = lecturer();
    const f = outsider({ isApprover: true });
    expect(engine.can(l, Action.FILE_VIEW, f, env())).toBe(true);
    expect(engine.can(l, Action.DOCUMENT_SIGN, f, env())).toBe(true);
    expect(engine.can(l, Action.DOCUMENT_APPROVE, f, env())).toBe(true);
  });

  it('approval: channel membership alone does not let anyone decide a route step', () => {
    expect(engine.evaluate(lecturer(), Action.DOCUMENT_APPROVE, file(), env()).reason).toBe('approval.not_approver');
  });

  it('DLP: an approver still cannot download a confidential file', () => {
    expect(engine.evaluate(lecturer(), Action.FILE_DOWNLOAD, outsider({ isApprover: true, confidential: true }), env()).reason).toBe(
      'dlp.view_only',
    );
  });

  it('only the uploader starts an approval route for a document', () => {
    const s = student();
    expect(engine.can(s, Action.APPROVAL_ROUTE_CREATE, file({ ownerId: s.userId }), env())).toBe(true);
    expect(engine.evaluate(s, Action.APPROVAL_ROUTE_CREATE, file({ ownerId: 'someone-else' }), env()).reason).toBe(
      'ownership.required',
    );
  });

  it('read-only members and archived channels cannot sign', () => {
    expect(engine.evaluate(student(), Action.DOCUMENT_SIGN, file({ memberRole: MemberRole.READ_ONLY }), env()).reason).toBe(
      'channel.read_only',
    );
    expect(engine.evaluate(student(), Action.DOCUMENT_SIGN, file({ archived: true }), env()).reason).toBe('channel.archived');
  });

  it('signing applies to files only, never to a whole channel', () => {
    expect(engine.evaluate(student(), Action.DOCUMENT_SIGN, channel(), env()).reason).toBe('resource.type_mismatch');
  });
});

describe('polls, formal votes and directives (Phase 6)', () => {
  const poll = (over: Parameters<typeof channel>[0] = {}) => channel({ type: ResourceType.VOTE, ...over });

  it('IDOR: a non-member can neither vote in nor read a poll of another channel', () => {
    const foreign = poll({ isMember: false, memberRole: undefined });
    expect(engine.evaluate(student(), Action.VOTE_CAST, foreign, env()).reason).toBe('membership.required');
    expect(engine.evaluate(student(), Action.MESSAGE_READ, foreign, env()).reason).toBe('membership.required');
    expect(engine.evaluate(student(), Action.POLL_CREATE, channel({ isMember: false, memberRole: undefined }), env()).reason).toBe(
      'membership.required',
    );
  });

  it('only moderators open votes in collegial bodies and broadcasts, but every member votes there', () => {
    const council = channel({ channelType: ChannelType.GOVERNANCE });
    expect(engine.evaluate(lecturer(), Action.POLL_CREATE, council, env()).reason).toBe('channel.not_moderator');
    expect(engine.can(lecturer(), Action.POLL_CREATE, { ...council, memberRole: MemberRole.OWNER }, env())).toBe(true);
    const ann = poll({ channelType: ChannelType.ANNOUNCEMENT });
    expect(engine.can(student(), Action.VOTE_CAST, ann, env())).toBe(true);
    expect(engine.can(student(), Action.POLL_CREATE, channel(), env())).toBe(true);
  });

  it('read-only members and archived channels cannot vote', () => {
    expect(engine.evaluate(student(), Action.VOTE_CAST, poll({ memberRole: MemberRole.READ_ONLY }), env()).reason).toBe('channel.read_only');
    expect(engine.evaluate(student(), Action.VOTE_CAST, poll({ archived: true }), env()).reason).toBe('channel.archived');
  });

  it('only the author or a moderator closes a poll', () => {
    const me = student();
    expect(engine.can(me, Action.POLL_MANAGE, poll({ ownerId: me.userId }), env())).toBe(true);
    expect(engine.evaluate(me, Action.POLL_MANAGE, poll({ ownerId: 'someone-else' }), env()).reason).toBe('ownership.required');
    expect(engine.can(me, Action.POLL_MANAGE, poll({ ownerId: 'someone-else', memberRole: MemberRole.MODERATOR }), env())).toBe(true);
  });

  it('resource confusion: vote actions need the right resource type', () => {
    expect(engine.evaluate(student(), Action.VOTE_CAST, channel(), env()).reason).toBe('resource.type_mismatch');
    expect(engine.evaluate(student(), Action.POLL_CREATE, poll(), env()).reason).toBe('resource.type_mismatch');
    expect(engine.evaluate(student(), Action.MESSAGE_ACK, poll(), env()).reason).toBe('resource.type_mismatch');
  });

  it('directives: members confirm, outsiders cannot', () => {
    const directive = channel({ type: ResourceType.MESSAGE, channelType: ChannelType.ANNOUNCEMENT });
    expect(engine.can(student(), Action.MESSAGE_ACK, directive, env())).toBe(true);
    expect(engine.evaluate(student(), Action.MESSAGE_ACK, { ...directive, isMember: false, memberRole: undefined }, env()).reason).toBe(
      'membership.required',
    );
  });

  it('guests vote only in guest spaces', () => {
    const guest = principal({ kind: PrincipalKind.GUEST, roles: [{ role: RoleCode.GUEST, tenantId: T_MAIN }] });
    expect(engine.can(guest, Action.VOTE_CAST, poll({ channelType: ChannelType.GUEST_SPACE }), env())).toBe(true);
    expect(engine.evaluate(guest, Action.VOTE_CAST, poll(), env()).reason).toBe('guest.isolation');
    expect(engine.can(guest, Action.POLL_CREATE, channel({ channelType: ChannelType.GUEST_SPACE }), env())).toBe(false);
  });
});

describe('calls and consultations (Phase 7)', () => {
  const host = target({
    userId: 'u-lecturer',
    kind: PrincipalKind.STAFF,
    roles: [RoleCode.LECTURER],
    activeCourseOfferingIds: ['co-algorithms'],
  });
  const slot = (over: Partial<Resource> = {}): Resource => ({
    type: ResourceType.CONSULTATION,
    id: 'slot-1',
    tenantId: T_MAIN,
    ownerId: 'u-lecturer',
    target: host,
    ...over,
  });
  const call = (over: Partial<Resource> = {}): Resource => ({ ...channel(), type: ResourceType.CALL, ownerId: 'u-lecturer', ...over });

  it('course channels: only the lecturer (moderator) starts a call; members join', () => {
    expect(engine.evaluate(student(), Action.CALL_START, channel(), env()).reason).toBe('channel.not_moderator');
    expect(engine.can(lecturer(), Action.CALL_START, channel({ memberRole: MemberRole.MODERATOR }), env())).toBe(true);
    expect(engine.can(student(), Action.CALL_JOIN, call(), env())).toBe(true);
    const group = channel({ channelType: ChannelType.ACADEMIC_GROUP });
    expect(engine.can(student(), Action.CALL_START, group, env())).toBe(true);
  });

  it('IDOR: a non-member cannot get a join token for a call by id', () => {
    const foreign = call({ isMember: false, memberRole: undefined });
    expect(engine.evaluate(student(), Action.CALL_JOIN, foreign, env()).reason).toBe('membership.required');
  });

  it('no calls in rooms with mandatory E2EE (the SFU would see the media)', () => {
    const trust = channel({ channelType: ChannelType.TRUST_ROOM, e2eeMode: E2eeMode.MANDATORY });
    expect(engine.evaluate(student(), Action.CALL_START, trust, env()).reason).toBe('call.e2ee_unavailable');
    expect(engine.evaluate(student(), Action.CALL_JOIN, call({ channelType: ChannelType.TRUST_ROOM, e2eeMode: E2eeMode.MANDATORY }), env()).reason).toBe(
      'call.e2ee_unavailable',
    );
  });

  it('read-only members cannot start calls; archived channels have none', () => {
    const ro = channel({ channelType: ChannelType.ACADEMIC_GROUP, memberRole: MemberRole.READ_ONLY });
    expect(engine.evaluate(student(), Action.CALL_START, ro, env()).reason).toBe('channel.read_only');
    expect(engine.evaluate(student(), Action.CALL_JOIN, call({ archived: true }), env()).reason).toBe('channel.archived');
  });

  it('only the starter or a moderator ends a call', () => {
    expect(engine.evaluate(student(), Action.CALL_MANAGE, call(), env()).reason).toBe('ownership.required');
    expect(engine.can(student(), Action.CALL_MANAGE, call({ ownerId: 'u-student' }), env())).toBe(true);
    expect(engine.can(lecturer(), Action.CALL_MANAGE, call({ memberRole: MemberRole.MODERATOR }), env())).toBe(true);
  });

  it('guests join calls only in guest spaces and never start them', () => {
    const guest = principal({ userId: 'u-guest', kind: PrincipalKind.GUEST, roles: [{ role: RoleCode.GUEST, tenantId: T_MAIN }] });
    const space = { channelType: ChannelType.GUEST_SPACE };
    expect(engine.can(guest, Action.CALL_JOIN, call(space), env())).toBe(true);
    expect(engine.evaluate(guest, Action.CALL_JOIN, call(), env()).reason).toBe('guest.isolation');
    expect(engine.can(guest, Action.CALL_START, channel(space), env())).toBe(false);
    expect(engine.can(guest, Action.CONSULTATION_BOOK, slot(), env())).toBe(false);
  });

  it('only teaching staff publish consultation slots', () => {
    const self = (userId: string) => ({ type: ResourceType.SELF, tenantId: T_MAIN, ownerId: userId });
    expect(engine.can(lecturer(), Action.CONSULTATION_HOST, self('u-lecturer'), env())).toBe(true);
    expect(engine.evaluate(student(), Action.CONSULTATION_HOST, self('u-student'), env()).reason).toBe('rbac.denied');
    const hr = principal({ userId: 'u-hr', kind: PrincipalKind.STAFF, roles: [{ role: RoleCode.FACILITIES_STAFF, tenantId: T_MAIN }] });
    expect(engine.can(hr, Action.CONSULTATION_HOST, self('u-hr'), env())).toBe(false);
  });

  it('booking follows the DM rules: a shared course is required for a lecturer', () => {
    expect(engine.can(student(), Action.CONSULTATION_BOOK, slot(), env())).toBe(true);
    const stranger = student({ activeCourseOfferingIds: ['co-civil-law'] });
    expect(engine.evaluate(stranger, Action.CONSULTATION_BOOK, slot(), env()).reason).toBe('dm.no_shared_course');
    const rector = slot({ ownerId: 'u-rector', target: target({ userId: 'u-rector', kind: PrincipalKind.STAFF, roles: [RoleCode.RECTORATE] }) });
    expect(engine.evaluate(student(), Action.CONSULTATION_BOOK, rector, env()).reason).toBe('dm.student_to_rectorate');
  });

  it('minor isolation: a lyceum pupil cannot book a university lecturer', () => {
    expect(engine.can(lyceumPupil(), Action.CONSULTATION_BOOK, slot(), env())).toBe(false);
  });

  it('a slot limited to a course accepts only its students; the host cannot book their own slot', () => {
    const limited = slot({ courseOfferingId: 'co-databases', target: { ...host, activeCourseOfferingIds: ['co-algorithms', 'co-databases'] } });
    expect(engine.evaluate(student(), Action.CONSULTATION_BOOK, limited, env()).reason).toBe('consultation.course_only');
    expect(engine.can(student({ activeCourseOfferingIds: ['co-databases'] }), Action.CONSULTATION_BOOK, limited, env())).toBe(true);
    expect(engine.evaluate(lecturer(), Action.CONSULTATION_BOOK, slot(), env()).reason).toBe('consultation.own_slot');
  });

  it('IDOR: only the host manages a slot; only the host and booked students enter its room', () => {
    expect(engine.evaluate(student(), Action.CONSULTATION_MANAGE, slot(), env()).reason).toBe('rbac.denied');
    const other = lecturer({ userId: 'u-other-lecturer' });
    expect(engine.evaluate(other, Action.CONSULTATION_MANAGE, slot(), env()).reason).toBe('ownership.required');
    expect(engine.can(lecturer(), Action.CONSULTATION_MANAGE, slot(), env())).toBe(true);
    expect(engine.evaluate(student(), Action.CALL_JOIN, slot(), env()).reason).toBe('membership.required');
    expect(engine.can(student(), Action.CALL_JOIN, slot({ isBooked: true }), env())).toBe(true);
    expect(engine.can(lecturer(), Action.CALL_JOIN, slot(), env())).toBe(true);
  });

  it('a student keeps access to their own booking after the course ends (to cancel it)', () => {
    const later = student({ activeCourseOfferingIds: [] });
    expect(engine.can(later, Action.CONSULTATION_BOOK, slot({ isBooked: true }), env())).toBe(true);
  });
});
