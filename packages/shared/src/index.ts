/**
 * Domain vocabulary shared by the API, the policy engine and (later) the web client.
 * Values must stay in sync with the enums in packages/database/prisma/schema.prisma.
 */

/** Isolated educational contours (tenants). */
export const TenantCode = {
  PUET_MAIN: 'PUET_MAIN',
  PUET_LYCEUM: 'PUET_LYCEUM',
  COLLEGE_POLTAVA: 'COLLEGE_POLTAVA',
  COLLEGE_CHERKASY: 'COLLEGE_CHERKASY',
  COLLEGE_BILHOROD: 'COLLEGE_BILHOROD',
} as const;
export type TenantCode = (typeof TenantCode)[keyof typeof TenantCode];

/** Role levels from section 2 of the technical specification. */
export const RoleCode = {
  /** 1. Information Center: cluster, SSO, EDEBO integration, security audit. */
  SUPER_ADMIN: 'SUPER_ADMIN',
  /** 2. Rector, first vice-rector, vice-rectors, academic secretary. */
  RECTORATE: 'RECTORATE',
  /** 3. Directors of the 7 institutes (ННІ), the colleges and the lyceum. */
  INSTITUTE_DIRECTOR: 'INSTITUTE_DIRECTOR',
  /** 4. Heads of the 17 departments (кафедри). */
  DEPARTMENT_HEAD: 'DEPARTMENT_HEAD',
  /** 4. Teaching staff (НПП), STEAM-HUB and Interlingua trainers. */
  LECTURER: 'LECTURER',
  /** 5. Chancellery, HR, Finance, Legal, Admissions, Quality Assurance, etc. */
  ADMIN_STAFF: 'ADMIN_STAFF',
  /** 6. Ombudsman, Psychological Service, Military Registration. */
  TRUST_SERVICE_OFFICER: 'TRUST_SERVICE_OFFICER',
  /** 6. Civil Protection Unit: emergency alerts that bypass Do Not Disturb. */
  CIVIL_PROTECTION_OFFICER: 'CIVIL_PROTECTION_OFFICER',
  /** 7. Facilities services (АГР). */
  FACILITIES_STAFF: 'FACILITIES_STAFF',
  /** 7. Dormitory commandant: the only role that sees room numbers. */
  DORM_COMMANDANT: 'DORM_COMMANDANT',
  /** 8. Students, lyceum pupils, postgraduates. */
  STUDENT: 'STUDENT',
  /** 8. Group leader (староста), on top of STUDENT. */
  GROUP_LEADER: 'GROUP_LEADER',
  /** 9. External stakeholders with TTL-limited access. */
  GUEST: 'GUEST',
  /** Machine principal for ЄДЕБО / HR / ERP webhooks. Never assigned to a person. */
  INTEGRATION: 'INTEGRATION',
} as const;
export type RoleCode = (typeof RoleCode)[keyof typeof RoleCode];

/** Roles that must pass TOTP/WebAuthn before any privileged action. */
export const MFA_REQUIRED_ROLES: readonly RoleCode[] = [
  RoleCode.SUPER_ADMIN,
  RoleCode.RECTORATE,
  RoleCode.INSTITUTE_DIRECTOR,
  RoleCode.ADMIN_STAFF,
  RoleCode.TRUST_SERVICE_OFFICER,
];

/** Roles that may hold grants across tenants. Everyone else is tenant-bound. */
export const CROSS_TENANT_ROLES: readonly RoleCode[] = [RoleCode.SUPER_ADMIN, RoleCode.RECTORATE];

export const PrincipalKind = {
  STAFF: 'STAFF',
  STUDENT: 'STUDENT',
  GUEST: 'GUEST',
  SERVICE_BOT: 'SERVICE_BOT',
} as const;
export type PrincipalKind = (typeof PrincipalKind)[keyof typeof PrincipalKind];

export const AccountStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  OFFBOARDED: 'OFFBOARDED',
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

export const ChannelType = {
  DIRECT: 'DIRECT',
  PRIVATE_GROUP: 'PRIVATE_GROUP',
  COURSE: 'COURSE',
  ACADEMIC_GROUP: 'ACADEMIC_GROUP',
  INSTITUTE: 'INSTITUTE',
  DEPARTMENT: 'DEPARTMENT',
  GOVERNANCE: 'GOVERNANCE',
  ADMIN_UNIT: 'ADMIN_UNIT',
  TRUST_ROOM: 'TRUST_ROOM',
  EMERGENCY: 'EMERGENCY',
  DORMITORY: 'DORMITORY',
  PROJECT: 'PROJECT',
  COMMUNITY: 'COMMUNITY',
  GUEST_SPACE: 'GUEST_SPACE',
  ANNOUNCEMENT: 'ANNOUNCEMENT',
} as const;
export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType];

/** Channel types whose content is private to members, even from administrators. */
export const PRIVATE_CHANNEL_TYPES: readonly ChannelType[] = [
  ChannelType.DIRECT,
  ChannelType.PRIVATE_GROUP,
  ChannelType.TRUST_ROOM,
];

export const E2eeMode = {
  MANDATORY: 'MANDATORY',
  OPTIONAL: 'OPTIONAL',
  DISABLED: 'DISABLED',
} as const;
export type E2eeMode = (typeof E2eeMode)[keyof typeof E2eeMode];

export const MemberRole = {
  OWNER: 'OWNER',
  MODERATOR: 'MODERATOR',
  MEMBER: 'MEMBER',
  READ_ONLY: 'READ_ONLY',
} as const;
export type MemberRole = (typeof MemberRole)[keyof typeof MemberRole];

/**
 * Every action the platform authorizes. HTTP routes, WebSocket events and file
 * downloads must each map to exactly one action.
 */
export const Action = {
  CHANNEL_READ: 'channel.read',
  CHANNEL_CREATE: 'channel.create',
  CHANNEL_UPDATE: 'channel.update',
  CHANNEL_ARCHIVE: 'channel.archive',
  CHANNEL_MODERATE: 'channel.moderate',
  CHANNEL_MEMBERS_MANAGE: 'channel.members.manage',
  MESSAGE_READ: 'message.read',
  MESSAGE_SEND: 'message.send',
  MESSAGE_EDIT: 'message.edit',
  MESSAGE_DELETE: 'message.delete',
  DM_START: 'dm.start',
  DIRECTORY_SEARCH: 'directory.search',
  USER_PROFILE_READ: 'user.profile.read',
  USER_PHONE_READ: 'user.phone.read',
  USER_DORM_ROOM_READ: 'user.dorm_room.read',
  FILE_UPLOAD: 'file.upload',
  FILE_VIEW: 'file.view',
  FILE_DOWNLOAD: 'file.download',
  DOCUMENT_SIGN: 'document.sign',
  DOCUMENT_APPROVE: 'document.approve',
  BROADCAST_PUBLISH: 'broadcast.publish',
  EMERGENCY_ALERT_SEND: 'emergency.alert.send',
  VOTE_CAST: 'vote.cast',
  VOTE_MANAGE: 'vote.manage',
  STRUCTURE_MANAGE: 'structure.manage',
  ROLE_ASSIGN: 'role.assign',
  POLICY_MANAGE: 'policy.manage',
  AUDIT_READ: 'audit.read',
  CERTIFICATE_REQUEST: 'certificate.request',
  CERTIFICATE_ISSUE: 'certificate.issue',
  CERTIFICATE_REVOKE: 'certificate.revoke',
  QUIET_HOURS_MANAGE: 'quiet_hours.manage',
  SESSION_READ: 'session.read',
  SYNC_INGEST: 'sync.ingest',
  /** Phase 3: the caller's own channel list, presence, devices and E2EE keys. */
  CHANNEL_LIST: 'channel.list',
  PRESENCE_UPDATE: 'presence.update',
  DEVICE_MANAGE: 'device.manage',
  /** Query / claim other users' public device keys and send them to-device envelopes. */
  E2EE_KEYS_ACCESS: 'e2ee.keys.access',
  /** Phase 4: JSON annotations on a PDF (never modifies the file). */
  FILE_ANNOTATE: 'file.annotate',
  /** Phase 4: start a multi-step approval route for one's own document. */
  APPROVAL_ROUTE_CREATE: 'approval.route.create',
  /** Phase 6: start a poll (or, in a collegial body, a formal vote) in a channel. */
  POLL_CREATE: 'poll.create',
  /** Phase 6: close a poll early (its author or a channel moderator). */
  POLL_MANAGE: 'poll.manage',
  /** Phase 6: confirm a directive («Ознайомлений»). */
  MESSAGE_ACK: 'message.ack',
} as const;
export type Action = (typeof Action)[keyof typeof Action];

export const ResourceType = {
  CHANNEL: 'channel',
  MESSAGE: 'message',
  FILE: 'file',
  USER: 'user',
  DIRECTORY: 'directory',
  DOCUMENT: 'document',
  VOTE: 'vote',
  STRUCTURE: 'structure',
  ROLE: 'role',
  POLICY: 'policy',
  AUDIT: 'audit',
  CERTIFICATE: 'certificate',
  SESSION: 'session',
  INTEGRATION: 'integration',
  /** The caller's own account settings (always owned by the caller). */
  SELF: 'self',
  DEVICE: 'device',
} as const;

/** Roles the ЄДЕБО / HR sync may grant. RECTORATE and SUPER_ADMIN are granted only by an administrator. */
export const SYNC_ASSIGNABLE_ROLES: readonly RoleCode[] = [
  RoleCode.INSTITUTE_DIRECTOR,
  RoleCode.DEPARTMENT_HEAD,
  RoleCode.LECTURER,
  RoleCode.ADMIN_STAFF,
  RoleCode.TRUST_SERVICE_OFFICER,
  RoleCode.CIVIL_PROTECTION_OFFICER,
  RoleCode.FACILITIES_STAFF,
  RoleCode.DORM_COMMANDANT,
  RoleCode.STUDENT,
  RoleCode.GROUP_LEADER,
];
export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType];
