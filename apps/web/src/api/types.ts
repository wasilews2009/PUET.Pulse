/** Response shapes of the PUET.Pulse API used by the web client. */

export type Locale = 'uk' | 'en';

export interface Me {
  userId: string;
  tenantId: string;
  tenantCode: string | null;
  kind: 'STAFF' | 'STUDENT' | 'GUEST' | 'SERVICE_BOT';
  isMinor: boolean;
  fullNameUk: string | null;
  fullNameEn: string | null;
  corporateId: string | null;
  locale: Locale;
  roles: { role: string; scope: Record<string, string>; expiresAt: string | null }[];
  mfaVerified: boolean;
  mfaRequired: boolean;
  themeOverrides: unknown;
}

export type ChannelType =
  | 'DIRECT'
  | 'PRIVATE_GROUP'
  | 'COURSE'
  | 'ACADEMIC_GROUP'
  | 'INSTITUTE'
  | 'DEPARTMENT'
  | 'GOVERNANCE'
  | 'ADMIN_UNIT'
  | 'TRUST_ROOM'
  | 'EMERGENCY'
  | 'DORMITORY'
  | 'PROJECT'
  | 'COMMUNITY'
  | 'GUEST_SPACE'
  | 'ANNOUNCEMENT';

export type E2eeMode = 'MANDATORY' | 'OPTIONAL' | 'DISABLED';
export type MemberRole = 'OWNER' | 'MODERATOR' | 'MEMBER' | 'READ_ONLY';

export interface Channel {
  id: string;
  type: ChannelType;
  e2eeMode: E2eeMode;
  nameUk: string | null;
  nameEn: string | null;
  topic: string | null;
  isOfficial: boolean;
  confidential: boolean;
  threadsRequired: boolean;
  messageTtlSeconds: number | null;
  archived: boolean;
  peerId: string | null;
  role: MemberRole;
  lastReadAt: string | null;
  mutedUntil: string | null;
  unread: number;
}

export interface Message {
  id: string;
  channelId: string;
  senderId: string;
  senderDeviceId: string | null;
  threadRootId: string | null;
  scheme: string;
  body: string | null;
  ciphertext: string | null;
  isPriority: boolean;
  /** Directive: members confirm «Ознайомлений». */
  requiresAck?: boolean;
  /** Set in history for directives: when the current user confirmed, or null. */
  acknowledgedAt?: string | null;
  pollId?: string | null;
  /** The call this message shows (Phase 7). */
  callId?: string | null;
  createdAt: string;
  editedAt: string | null;
  expiresAt: string | null;
  deleted: boolean;
  replyCount?: number;
}

export interface Poll {
  id: string;
  channelId: string;
  messageId: string;
  createdById: string;
  question: string;
  /** Labels; formal votes use FOR / AGAINST / ABSTAIN codes. */
  options: string[];
  mode: 'OPEN' | 'SECRET';
  multipleChoice: boolean;
  formal: boolean;
  quorum: number | null;
  eligibleCount: number;
  status: 'OPEN' | 'CLOSED';
  closesAt: string | null;
  closedAt: string | null;
  createdAt: string;
  participants: number;
  counts: number[] | null;
  voters: string[][] | null;
  me: { voted: boolean; eligible: boolean; options: number[] | null };
  quorumReached: boolean | null;
  adopted: boolean | null;
}

export interface Call {
  id: string;
  kind: 'CHANNEL' | 'CONSULTATION';
  channelId: string | null;
  slotId: string | null;
  messageId: string | null;
  startedById: string;
  startedAt: string;
  endedAt: string | null;
  participants: string[];
}

export interface CallJoin {
  callId: string;
  url: string;
  token: string;
  canPublish: boolean;
  expiresAt: string;
}

export interface Booking {
  id: string;
  studentId: string;
  topic: string | null;
  createdAt: string;
}

export interface Slot {
  id: string;
  hostId: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  booked: number;
  mode: 'ONLINE' | 'OFFLINE';
  location: string | null;
  courseOfferingId: string | null;
  course: { nameUk: string; nameEn: string } | null;
  note: string | null;
  status: 'ACTIVE' | 'CANCELLED';
  myBooking: Booking | null;
  bookings: Booking[] | null;
  bookable: boolean;
  callId: string | null;
}

export interface ConsultationHost {
  userId: string;
  courses: { nameUk: string; nameEn: string }[];
  upcoming: number;
}

export interface AckStats {
  messageId: string;
  total: number;
  acknowledged: { userId: string; at: string }[];
  pending: string[];
}

export type Presence = 'ONLINE' | 'IN_CLASS' | 'IN_COUNCIL' | 'ON_BUSINESS_TRIP' | 'DO_NOT_DISTURB' | 'OFFLINE';

export interface UserCard {
  id: string;
  kind: string;
  fullNameUk: string;
  fullNameEn: string | null;
  position: string | null;
  academicDegree: string | null;
  academicTitle: string | null;
  presence: Presence;
}

export interface Member {
  userId: string;
  role: MemberRole;
}

export type FileStatus = 'PENDING' | 'READY' | 'REJECTED' | 'FAILED';

export interface FileItem {
  id: string;
  channelId: string | null;
  uploaderId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: FileStatus;
  confidential: boolean;
  viewable: boolean;
  pageCount: number | null;
  sha256: string | null;
  createdAt: string;
}

export type AnnotationKind = 'highlight' | 'underline' | 'strike' | 'comment' | 'note';
export type AnnotationColor = 'yellow' | 'green' | 'blue' | 'red' | 'navy' | 'terracotta';
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Annotation {
  id: string;
  authorId: string;
  page: number;
  visibility: 'PRIVATE' | 'SHARED';
  kind: AnnotationKind;
  rects: Rect[];
  text?: string;
  color: AnnotationColor;
  createdAt: string;
  updatedAt: string;
}

export interface Signature {
  id: string;
  fileId: string;
  signerId: string;
  signerName: string;
  provider: 'INTERNAL_PKI' | 'EXTERNAL_QES';
  level: 'УЕП' | 'КЕП';
  format: string;
  certificateId: string;
  certificateSerial: string;
  signedDigest: string;
  claimedSigningTime: string | null;
  tspTimestamp: string | null;
  createdAt: string;
}

export interface SignatureCheck {
  id: string;
  signer: { fullName: string; title: string | null };
  level: 'УЕП' | 'КЕП';
  format: string;
  signedAt: string;
  claimedSigningTime: string | null;
  tspTime: string | null;
  certificate: { serialNumber: string; issuer: string; notAfter: string; status: string; revokedAt: string | null };
  digestMatches: boolean;
  valid: boolean;
}

export interface VerificationProtocol {
  document: { id: string; fileName?: string; sha256: string; sizeBytes: number; pages: number | null; integrity: 'intact' | 'modified' };
  signatures: SignatureCheck[];
  approval: { title?: string; status: string; steps: { position: number; approverName: string; status: string; decidedAt: string | null }[] } | null;
  checkedAt: string;
  verifyUrl?: string;
  qrSvg?: string;
}

export interface Certificate {
  id: string;
  provider: 'INTERNAL_PKI' | 'EXTERNAL_QES';
  serialNumber: string;
  subjectDn: string;
  issuerDn: string;
  notBefore: string;
  notAfter: string;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'SUPERSEDED' | string;
  revokedAt: string | null;
  revocationReason: string | null;
  certificatePem: string;
}

export interface ApprovalStep {
  id: string;
  position: number;
  approverId: string;
  approverName: string;
  requireSignature: boolean;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED' | string;
  signatureId: string | null;
  comment: string | null;
  decidedAt: string | null;
}

export interface ApprovalRoute {
  id: string;
  fileId: string;
  title: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | string;
  createdById: string;
  createdByName: string;
  createdAt: string;
  currentStepId: string | null;
  steps: ApprovalStep[];
  file?: { id: string; fileName: string; channelId: string | null };
}

export interface QuietHours {
  enabled: boolean;
  timezone: string;
  startMinute: number;
  endMinute: number;
  weekdays: number[];
  digestEnabled: boolean;
}

export interface Named {
  id: string;
  code: string;
  nameUk: string;
  nameEn: string;
  isActive?: boolean;
}

export interface Structure {
  tenant: { id: string; code: string; nameUk: string; nameEn: string };
  institutes: (Named & { bilingualUi: boolean; defaultLocale: Locale })[];
  departments: Named[];
  orgUnits: (Named & { kind: string; e2eeMode: E2eeMode; confidential: boolean; parentId: string | null; bypassesQuietHours: boolean })[];
  dormitories: { id: string; number: number; nameUk: string; nameEn: string; floors: number }[];
  academicGroups: { id: string; code: string; instituteId: string; educationLevel: string; studyForm: string; courseYear: number }[];
}

export interface RoleAssignment {
  id: string;
  userId: string;
  role: string;
  source: 'SYNC' | 'MANUAL' | string;
  tenantId: string | null;
  instituteId: string | null;
  departmentId: string | null;
  orgUnitId: string | null;
  dormitoryId: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface PermissionMatrix {
  source: 'database' | 'default';
  roles: Record<string, string[]>;
  actions: string[];
}

export interface AbacPolicy {
  id: string;
  key: string;
  description: string | null;
  effect: 'ALLOW' | 'DENY';
  actions: string[];
  resourceTypes: string[];
  tenantId: string | null;
  condition: unknown;
  priority: number;
  enabled: boolean;
}

export interface Decision {
  allowed: boolean;
  reason?: string;
  resolved?: boolean;
  matchedPolicies?: string[];
}

export interface AuditEntry {
  id: string;
  occurredAt: string;
  actorId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  reason: string | null;
  ip: string | null;
}
