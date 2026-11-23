import { SYNC_ASSIGNABLE_ROLES, type RoleCode } from '@puet/shared';
import { z } from 'zod';

const MAX_BATCH = 1000;
const code = z.string().trim().min(1).max(64);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const name = z.string().trim().min(1).max(256);

export const educationLevel = z.enum(['LYCEUM', 'JUNIOR_BACHELOR', 'BACHELOR', 'MASTER', 'PHD', 'DOCTORATE']);
export const studyForm = z.enum(['FULL_TIME', 'PART_TIME', 'DISTANCE', 'DUAL']);

const person = {
  corporateId: code,
  email: z.string().trim().toLowerCase().email().max(254),
  fullNameUk: name,
  fullNameEn: name.optional(),
  phone: z
    .string()
    .regex(/^\+?[0-9 ()-]{7,20}$/)
    .optional(),
  birthDate: isoDate.optional(),
  locale: z.enum(['uk', 'en']).optional(),
};

/** One student from ЄДЕБО / Деканат. */
export const studentRecord = z.object({
  edeboId: code,
  ...person,
  status: z.enum(['ACTIVE', 'ACADEMIC_LEAVE', 'EXPELLED']).default('ACTIVE'),
  educationLevel,
  studyForm: studyForm.default('FULL_TIME'),
  instituteCode: code.optional(),
  groupCode: code.optional(),
  specialty: z.string().max(256).optional(),
  courseYear: z.number().int().min(1).max(12).optional(),
  dormitory: z
    .object({ number: z.number().int().min(1).max(99), room: code, floor: z.number().int().min(0).max(40) })
    .optional(),
  isGroupLeader: z.boolean().default(false),
  isActivist: z.boolean().default(false),
  isForeign: z.boolean().default(false),
});
export type StudentRecord = z.infer<typeof studentRecord>;

const syncRole = z.object({
  role: z
    .string()
    .refine((r): r is RoleCode => SYNC_ASSIGNABLE_ROLES.includes(r as RoleCode), 'role is not sync-assignable'),
  instituteCode: code.optional(),
  departmentCode: code.optional(),
  orgUnitCode: code.optional(),
  dormitoryNumber: z.number().int().min(1).max(99).optional(),
});

/** One employee from the HR system. */
export const staffRecord = z.object({
  hrId: code,
  ...person,
  status: z.enum(['ACTIVE', 'ON_LEAVE', 'DISMISSED']).default('ACTIVE'),
  position: name,
  academicDegree: z.string().max(128).optional(),
  academicTitle: z.string().max(128).optional(),
  primaryDepartmentCode: code.optional(),
  departmentCodes: z.array(code).max(17).default([]),
  orgUnitCodes: z.array(code).max(32).default([]),
  roles: z.array(syncRole).max(16).default([]),
});
export type StaffRecord = z.infer<typeof staffRecord>;

export const studentBatch = z.object({ records: z.array(studentRecord).min(1).max(MAX_BATCH) });
export const staffBatch = z.object({ records: z.array(staffRecord).min(1).max(MAX_BATCH) });

/** Semester teaching load from ERP: builds CourseOfferings (Phase 3 provisions their channels). */
export const teachingLoad = z.object({
  semester: z.object({ code, startsOn: isoDate, endsOn: isoDate, isCurrent: z.boolean().default(false) }),
  offerings: z
    .array(
      z.object({
        externalId: code,
        departmentCode: code,
        discipline: z.object({ code, nameUk: name, nameEn: name, isElective: z.boolean().default(false) }),
        lecturerHrIds: z.array(code).min(1).max(20),
        groupCodes: z.array(code).min(1).max(50),
      }),
    )
    .min(1)
    .max(MAX_BATCH),
});
export type TeachingLoad = z.infer<typeof teachingLoad>;

export const offboarding = z.object({
  records: z
    .array(
      z
        .object({
          edeboId: code.optional(),
          hrId: code.optional(),
          reason: z.enum(['EXPELLED', 'GRADUATED', 'DISMISSED', 'DECEASED', 'OTHER']),
        })
        .refine((r) => !!r.edeboId !== !!r.hrId, 'exactly one of edeboId / hrId'),
    )
    .min(1)
    .max(MAX_BATCH),
});
export type Offboarding = z.infer<typeof offboarding>;

/** Age in whole years on `now` from a YYYY-MM-DD date; under 18 = minor. */
export function computeIsMinor(birthDate: string | undefined, tenantMinorProtected: boolean, now = new Date()): boolean {
  if (tenantMinorProtected) return true;
  if (!birthDate) return false;
  const [y, m, d] = birthDate.split('-').map(Number) as [number, number, number];
  let age = now.getUTCFullYear() - y;
  const beforeBirthday = now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d);
  if (beforeBirthday) age--;
  return age < 18;
}
