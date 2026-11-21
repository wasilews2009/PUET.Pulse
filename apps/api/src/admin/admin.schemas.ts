import { Action, RoleCode } from '@puet/shared';
import { z } from 'zod';

const code = z
  .string()
  .trim()
  .regex(/^[A-Z0-9_]{2,64}$/, 'UPPER_SNAKE_CASE code');
const name = z.string().trim().min(1).max(256);
const uuid = z.string().uuid();

export const instituteInput = z.object({
  code,
  nameUk: name,
  nameEn: name,
  bilingualUi: z.boolean().default(false),
  defaultLocale: z.enum(['uk', 'en']).default('uk'),
});
export const instituteUpdate = instituteInput.partial().extend({ isActive: z.boolean().optional() });

export const departmentInput = z.object({ code, nameUk: name, nameEn: name });
export const departmentUpdate = departmentInput.partial().extend({ isActive: z.boolean().optional() });

export const orgUnitInput = z.object({
  code,
  kind: z.enum([
    'GOVERNANCE',
    'ADMIN_SERVICE',
    'TRUST_SERVICE',
    'SAFETY_SERVICE',
    'ACADEMIC_CENTER',
    'FACILITIES',
    'CAMPUS',
    'COMMUNITY',
    'EXTERNAL',
  ]),
  nameUk: name,
  nameEn: name,
  parentId: uuid.nullable().optional(),
  confidential: z.boolean().default(false),
  e2eeMode: z.enum(['MANDATORY', 'OPTIONAL', 'DISABLED']).default('DISABLED'),
  anonymousIntake: z.boolean().default(false),
  bypassesQuietHours: z.boolean().default(false),
  forbidExternalForward: z.boolean().default(false),
});
export const orgUnitUpdate = orgUnitInput.partial().extend({ isActive: z.boolean().optional() });

export const dormitoryInput = z.object({
  number: z.number().int().min(1).max(99),
  nameUk: name,
  nameEn: name,
  address: z.string().max(512).optional(),
  floors: z.number().int().min(1).max(40).default(5),
});

export const promoteInput = z.object({
  /** Highest course year per education level; groups already there are not promoted. */
  maxCourseYear: z
    .record(z.enum(['LYCEUM', 'JUNIOR_BACHELOR', 'BACHELOR', 'MASTER', 'PHD', 'DOCTORATE']), z.number().int().min(1).max(12))
    .default({}),
  dryRun: z.boolean().default(false),
});

const assignableRoles = Object.values(RoleCode).filter((r) => r !== RoleCode.INTEGRATION) as [string, ...string[]];

export const roleGrantInput = z.object({
  userId: uuid,
  role: z.enum(assignableRoles),
  instituteId: uuid.optional(),
  departmentId: uuid.optional(),
  orgUnitId: uuid.optional(),
  dormitoryId: uuid.optional(),
  expiresAt: z.coerce.date().optional(),
  /** Grant across all tenants (SUPER_ADMIN and RECTORATE only). */
  crossTenant: z.boolean().default(false),
});
export type RoleGrantInput = z.infer<typeof roleGrantInput>;

const actions = Object.values(Action) as [string, ...string[]];
export const actionList = z.array(z.enum(actions)).max(actions.length);

export const permissionUpdate = z.object({ actions: actionList });

export const policyInput = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
  description: z.string().max(1000).optional(),
  effect: z.enum(['ALLOW', 'DENY']),
  actions: z.array(z.union([z.enum(actions), z.literal('*')])).min(1),
  resourceTypes: z.array(z.string().max(32)).default(['*']),
  tenantId: uuid.nullable().optional(),
  condition: z.unknown(),
  priority: z.number().int().min(-1000).max(1000).default(0),
  enabled: z.boolean().default(true),
});
export const policyUpdate = policyInput.omit({ key: true }).partial();

export const simulateInput = z.object({
  userId: uuid,
  action: z.enum(actions),
  resource: z.object({
    type: z.string().max(32),
    id: uuid.optional(),
  }),
  mfaVerified: z.boolean().default(true),
});

export const auditQuery = z.object({
  beforeId: z.coerce.bigint().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().max(64).optional(),
  actorId: uuid.optional(),
  outcome: z.enum(['SUCCESS', 'DENIED', 'FAILURE']).optional(),
});

export const auditVerifyQuery = z.object({
  fromId: z.coerce.bigint().default(1n),
  limit: z.coerce.number().int().min(1).max(10_000).default(1000),
});
