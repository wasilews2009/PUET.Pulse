/**
 * Idempotent seed: tenants, PUET structure, dormitories, default permission matrix
 * and per-tenant emergency / governance channels. Contains no personal data.
 *
 *   pnpm db:seed
 */
import { PrismaClient, type RoleCode } from '@prisma/client';
import { DEFAULT_PERMISSION_MATRIX } from '@puet/policy-engine';
import {
  DEPARTMENTS,
  DORMITORY_NUMBERS,
  INSTITUTES,
  ORG_UNITS,
  SATELLITE_ORG_UNITS,
  TENANTS,
  type OrgUnitSeed,
} from './seed-data';

const prisma = new PrismaClient();

async function upsertOrgUnit(tenantId: string, unit: OrgUnitSeed, parentId?: string) {
  const data = {
    kind: unit.kind,
    nameUk: unit.nameUk,
    nameEn: unit.nameEn,
    confidential: unit.confidential ?? false,
    e2eeMode: unit.e2eeMode ?? 'DISABLED',
    anonymousIntake: unit.anonymousIntake ?? false,
    bypassesQuietHours: unit.bypassesQuietHours ?? false,
    forbidExternalForward: unit.forbidExternalForward ?? false,
    parentId: parentId ?? null,
  } as const;
  return prisma.orgUnit.upsert({
    where: { tenantId_code: { tenantId, code: unit.code } },
    update: data,
    create: { tenantId, code: unit.code, ...data },
  });
}

async function ensureChannel(params: {
  tenantId: string;
  orgUnitId: string;
  type: 'EMERGENCY' | 'GOVERNANCE' | 'TRUST_ROOM';
  nameUk: string;
  nameEn: string;
  e2eeMode: 'MANDATORY' | 'DISABLED';
  confidential?: boolean;
  isOfficial?: boolean;
}) {
  const existing = await prisma.channel.findFirst({
    where: { tenantId: params.tenantId, orgUnitId: params.orgUnitId, type: params.type },
  });
  if (existing) return existing;
  return prisma.channel.create({ data: { ...params, confidential: params.confidential ?? false } });
}

async function main() {
  // Permission matrix
  for (const [role, actions] of Object.entries(DEFAULT_PERMISSION_MATRIX)) {
    for (const action of actions ?? []) {
      await prisma.rolePermission.upsert({
        where: { role_action: { role: role as RoleCode, action } },
        update: {},
        create: { role: role as RoleCode, action },
      });
    }
  }

  for (const t of TENANTS) {
    const tenant = await prisma.tenant.upsert({
      where: { code: t.code },
      update: { nameUk: t.nameUk, nameEn: t.nameEn, city: t.city, minorProtected: t.minorProtected },
      create: t,
    });

    const isMain = t.code === 'PUET_MAIN';
    const units = isMain ? ORG_UNITS : ORG_UNITS.filter((u) => SATELLITE_ORG_UNITS.includes(u.code));
    const byCode = new Map<string, string>();
    for (const unit of units.filter((u) => !u.parent)) {
      byCode.set(unit.code, (await upsertOrgUnit(tenant.id, unit)).id);
    }
    for (const unit of units.filter((u) => u.parent)) {
      byCode.set(unit.code, (await upsertOrgUnit(tenant.id, unit, byCode.get(unit.parent!))).id);
    }

    const civil = byCode.get('CIVIL_PROTECTION');
    if (civil) {
      await ensureChannel({
        tenantId: tenant.id,
        orgUnitId: civil,
        type: 'EMERGENCY',
        nameUk: 'Термінові сповіщення ЦЗ',
        nameEn: 'Civil Protection Alerts',
        e2eeMode: 'DISABLED',
        isOfficial: true,
      });
    }

    if (!isMain) continue;

    for (const inst of INSTITUTES) {
      await prisma.institute.upsert({
        where: { tenantId_code: { tenantId: tenant.id, code: inst.code } },
        update: { nameUk: inst.nameUk, nameEn: inst.nameEn, bilingualUi: inst.bilingualUi ?? false },
        create: {
          tenantId: tenant.id,
          code: inst.code,
          nameUk: inst.nameUk,
          nameEn: inst.nameEn,
          bilingualUi: inst.bilingualUi ?? false,
          defaultLocale: inst.bilingualUi ? 'en' : 'uk',
        },
      });
    }

    for (const dept of DEPARTMENTS) {
      await prisma.department.upsert({
        where: { tenantId_code: { tenantId: tenant.id, code: dept.code } },
        update: { nameUk: dept.nameUk, nameEn: dept.nameEn },
        create: { tenantId: tenant.id, ...dept },
      });
    }

    const campusId = byCode.get('STUDENT_CAMPUS');
    for (const number of DORMITORY_NUMBERS) {
      await prisma.dormitory.upsert({
        where: { tenantId_number: { tenantId: tenant.id, number } },
        update: {},
        create: {
          tenantId: tenant.id,
          campusId: campusId ?? null,
          number,
          nameUk: `Гуртожиток № ${number}`,
          nameEn: `Dormitory No. ${number}`,
        },
      });
    }

    const governance: [string, string, string, 'MANDATORY' | 'DISABLED', boolean][] = [
      ['RECTORATE', 'Ректорат (закрита кімната)', 'Rectorate (closed room)', 'MANDATORY', true],
      ['ACADEMIC_COUNCIL', 'Вчена рада', 'Academic Council', 'DISABLED', true],
      ['SCI_METHOD_COUNCIL', 'Науково-методична рада', 'Scientific and Methodological Council', 'DISABLED', false],
    ];
    for (const [code, nameUk, nameEn, e2eeMode, confidential] of governance) {
      await ensureChannel({
        tenantId: tenant.id,
        orgUnitId: byCode.get(code)!,
        type: 'GOVERNANCE',
        nameUk,
        nameEn,
        e2eeMode,
        confidential,
        isOfficial: true,
      });
    }
  }

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
