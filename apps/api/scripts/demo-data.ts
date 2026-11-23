/**
 * Test data for a trial run or a pilot stand. NEVER on the production server.
 *
 *   pnpm --filter @puet/api demo:data
 *
 * Sends the same signed webhooks the HR system, ЄДЕБО and ERP send (HR_STAFF,
 * EDEBO_STUDENTS, TEACHING_LOAD) to a running API, so the people, groups,
 * course and their channels are created by the normal sync and provisioning
 * code. Nothing is written to the database directly.
 *
 * Needs an integration client "demo" in INTEGRATION_CLIENTS with those three
 * kinds and tenant PUET_MAIN (see docs/DEPLOYMENT.md). Every person is
 * fictional; their e-mails end in @demo.pulse.test, which matches the demo
 * Keycloak realm (infra/keycloak/puet-realm.json).
 */
import { randomUUID } from 'node:crypto';
import { sign } from '../src/integrations/hmac';

const API = (process.env.DEMO_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const DOMAIN = 'demo.pulse.test';

function client() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to load demo people with NODE_ENV=production');
  const all = JSON.parse(process.env.INTEGRATION_CLIENTS ?? '{}') as Record<string, { secret?: string; tenantCode?: string; kinds?: string[] }>;
  const c = all.demo;
  if (!c?.secret) throw new Error('INTEGRATION_CLIENTS has no "demo" client');
  if (c.tenantCode !== 'PUET_MAIN') throw new Error('The "demo" client must be bound to PUET_MAIN');
  return c.secret;
}

async function post(secret: string, path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${API}/integrations/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-puet-client': 'demo',
      'x-puet-signature': sign(secret, Math.floor(Date.now() / 1000), body),
      'idempotency-key': randomUUID(),
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  console.log(`${path}: ${text.slice(0, 200)}`);
}

function semester(now = new Date()) {
  const y = now.getUTCFullYear();
  const autumn = now.getUTCMonth() >= 7 || now.getUTCMonth() === 0;
  const start = autumn ? `${now.getUTCMonth() === 0 ? y - 1 : y}-09-01` : `${y}-02-01`;
  const end = autumn ? `${now.getUTCMonth() === 0 ? y : y + 1}-01-31` : `${y}-06-30`;
  return { code: `DEMO-${start.slice(0, 7)}`, startsOn: start, endsOn: end, isCurrent: true };
}

function birthDate(yearsAgo: number) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - yearsAgo);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const secret = client();
  await post(secret, 'hr/staff', {
    records: [
      {
        hrId: 'DEMO-HR-ADMIN',
        corporateId: 'DEMO-ADMIN',
        email: `admin@${DOMAIN}`,
        fullNameUk: 'Демо Адміністратор',
        fullNameEn: 'Demo Administrator',
        position: 'Адміністратор системи',
        orgUnitCodes: ['IT_CENTER'],
      },
      {
        hrId: 'DEMO-HR-LECTURER',
        corporateId: 'DEMO-LECTURER',
        email: `lecturer@${DOMAIN}`,
        fullNameUk: 'Олена Демченко',
        fullNameEn: 'Olena Demchenko',
        position: 'Доцент',
        academicDegree: 'к.е.н.',
        primaryDepartmentCode: 'COMPUTER_SCIENCE_IT',
        departmentCodes: ['COMPUTER_SCIENCE_IT'],
        roles: [{ role: 'LECTURER', departmentCode: 'COMPUTER_SCIENCE_IT' }],
      },
      {
        hrId: 'DEMO-HR-OMBUDSMAN',
        corporateId: 'DEMO-OMBUDSMAN',
        email: `ombudsman@${DOMAIN}`,
        fullNameUk: 'Ігор Тестовий',
        fullNameEn: 'Ihor Testovyi',
        position: 'Уповноважений з прав учасників освітнього процесу',
        orgUnitCodes: ['OMBUDSMAN'],
        roles: [{ role: 'TRUST_SERVICE_OFFICER', orgUnitCode: 'OMBUDSMAN' }],
      },
    ],
  });
  const student = (n: string, edeboId: string, fullNameUk: string, fullNameEn: string, age: number, leader = false) => ({
    edeboId,
    corporateId: edeboId.replace('EDEBO', 'STUDENT'),
    email: `${n}@${DOMAIN}`,
    fullNameUk,
    fullNameEn,
    birthDate: birthDate(age),
    educationLevel: 'BACHELOR',
    instituteCode: 'NNI_DAYTIME',
    groupCode: 'DEMO-KN-21',
    specialty: '122 Комп’ютерні науки',
    courseYear: 2,
    isGroupLeader: leader,
  });
  await post(secret, 'edebo/students', {
    records: [
      student('student', 'DEMO-EDEBO-1', 'Андрій Пробний', 'Andrii Probnyi', 19, true),
      student('student2', 'DEMO-EDEBO-2', 'Марія Зразкова', 'Mariia Zrazkova', 20),
      // Under 18: shows the minor protections (contacts, directory, content filter).
      student('minor', 'DEMO-EDEBO-3', 'Софія Юна', 'Sofiia Yuna', 16),
    ],
  });
  await post(secret, 'teaching-load', {
    semester: semester(),
    offerings: [
      {
        externalId: 'DEMO-OFFERING-1',
        departmentCode: 'COMPUTER_SCIENCE_IT',
        discipline: { code: 'DEMO-WEB', nameUk: 'Вебтехнології (демо)', nameEn: 'Web technologies (demo)' },
        lecturerHrIds: ['DEMO-HR-LECTURER'],
        groupCodes: ['DEMO-KN-21'],
      },
    ],
  });
  console.log('Demo people loaded. Grant the first administrator with: pnpm --filter @puet/api admin:bootstrap DEMO-ADMIN');
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
