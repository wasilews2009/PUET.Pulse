/**
 * End-to-end tests of Phase 2 against a real PostgreSQL (migrated + seeded):
 * SSO login, sessions, CSRF, MFA step-up, signed sync webhooks, offboarding,
 * admin panel guardrails and the policy simulator, all over HTTP.
 *
 *   RUN_DB_TESTS=1 DATABASE_URL=... pnpm --filter @puet/api test
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@puet/database';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule, REDIS } from '../../src/app.module';
import { OIDC_PROVIDER, type IdTokenClaims, type OidcProvider } from '../../src/auth/oidc.service';
import { APP_CONFIG, loadConfig } from '../../src/config/config';
import { sign } from '../../src/integrations/hmac';
import { DIGEST_STORE, MemoryDigestStore } from '../../src/notifications/digest.store';
import { MemoryRealtimeBus, REALTIME_BUS } from '../../src/realtime/realtime.bus';
import { MemorySessionStore, SESSION_STORE } from '../../src/session/session.store';

const enabled = process.env.RUN_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const WEB = 'https://pulse.test';
const sfx = randomUUID().slice(0, 8).toUpperCase();

const clients = {
  hr: { id: randomUUID(), secret: 'h'.repeat(40), tenantCode: 'PUET_MAIN', kinds: ['HR_STAFF', 'TEACHING_LOAD', 'OFFBOARDING'] },
  edebo: { id: randomUUID(), secret: 'e'.repeat(40), tenantCode: 'PUET_MAIN', kinds: ['EDEBO_STUDENTS'] },
  lyceum: { id: randomUUID(), secret: 'l'.repeat(40), tenantCode: 'PUET_LYCEUM', kinds: ['EDEBO_STUDENTS'] },
};

let nextClaims: IdTokenClaims = { sub: 'nobody' };
const fakeOidc: OidcProvider = {
  authorizationUrl: async (p) => `https://sso.test/auth?state=${p.state}${p.acr ? `&acr_values=${p.acr}` : ''}`,
  exchange: async () => nextClaims,
  endSessionUrl: async () => undefined,
};

describe.skipIf(!enabled)('Phase 2 end-to-end (PostgreSQL)', () => {
  let app: INestApplication;
  let base: string;
  const prisma = new PrismaClient();
  let mainId: string;
  let adminId: string;

  async function http(path: string, init: RequestInit & { cookie?: string } = {}) {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set('cookie', init.cookie);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    return fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' });
  }

  async function webhook(client: keyof typeof clients, path: string, payload: unknown, key = randomUUID(), secret?: string) {
    const body = JSON.stringify(payload);
    const t = Math.floor(Date.now() / 1000);
    return http(`/integrations/${path}`, {
      method: 'POST',
      body,
      headers: {
        'x-puet-client': client,
        'x-puet-signature': sign(secret ?? clients[client].secret, t, body),
        'idempotency-key': key,
      },
    });
  }

  async function login(claims: IdTokenClaims): Promise<{ cookie?: string; location: string }> {
    nextClaims = claims;
    let res = await http('/auth/login?returnTo=/chats');
    let state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    res = await http(`/auth/callback?code=c&state=${state}`);
    let location = res.headers.get('location')!;
    if (location.startsWith('https://sso.test/')) {
      // MFA step-up round trip
      state = new URL(location).searchParams.get('state')!;
      res = await http(`/auth/callback?code=c&state=${state}`);
      location = res.headers.get('location')!;
    }
    const setCookie = res.headers.get('set-cookie');
    return { ...(setCookie ? { cookie: setCookie.split(';')[0]! } : {}), location };
  }

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      WEB_ORIGIN: WEB,
      REDIS_URL: 'redis://unused',
      OIDC_ISSUER_URL: 'https://sso.test/realms/puet',
      OIDC_CLIENT_ID: 'pulse',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_REDIRECT_URI: `${WEB}/api/auth/callback`,
      INTEGRATION_CLIENTS: JSON.stringify(clients),
      JOBS_ENABLED: 'false',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(REDIS)
      .useValue({})
      .overrideProvider(SESSION_STORE)
      .useValue(new MemorySessionStore())
      .overrideProvider(OIDC_PROVIDER)
      .useValue(fakeOidc)
      .overrideProvider(REALTIME_BUS)
      .useValue(new MemoryRealtimeBus())
      .overrideProvider(DIGEST_STORE)
      .useValue(new MemoryDigestStore())
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: ['error'] });
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    mainId = (await prisma.tenant.findUniqueOrThrow({ where: { code: 'PUET_MAIN' } })).id;
    const admin = await prisma.user.create({
      data: {
        tenantId: mainId,
        corporateId: `ADM-${sfx}`,
        email: `admin-${sfx}@puet.test`,
        fullNameUk: 'Адміністратор Тест',
        kind: 'STAFF',
        oidcSubject: `sub-admin-${sfx}`,
        roleAssignments: { create: { role: 'SUPER_ADMIN', tenantId: null, source: 'ADMIN' } },
      },
    });
    adminId = admin.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  // ── Sync webhooks ──────────────────────────────────────────────

  it('HR sync creates a lecturer with a department-scoped grant', async () => {
    const res = await webhook('hr', 'hr/staff', {
      records: [
        {
          hrId: `HR-${sfx}`,
          corporateId: `L-${sfx}`,
          email: `lecturer-${sfx}@puet.test`,
          fullNameUk: 'Викладач Тест',
          phone: '+380501112233',
          position: 'Доцент',
          primaryDepartmentCode: 'COMPUTER_SCIENCE_IT',
          roles: [{ role: 'LECTURER' }],
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replayed: false, created: 1, errors: [] });
  });

  it('rejects a bad signature, an unknown client and a kind the client may not send', async () => {
    expect((await webhook('hr', 'hr/staff', { records: [] }, undefined, 'z'.repeat(40))).status).toBe(401);
    const unknown = await http('/integrations/hr/staff', { method: 'POST', body: '{}', headers: { 'x-puet-client': 'nope' } });
    expect(unknown.status).toBe(401);
    expect((await webhook('edebo', 'hr/staff', { records: [] })).status).toBe(403);
  });

  it('HR sync cannot grant RECTORATE or SUPER_ADMIN', async () => {
    const res = await webhook('hr', 'hr/staff', {
      records: [{ hrId: `HR2-${sfx}`, corporateId: `R-${sfx}`, email: `r-${sfx}@puet.test`, fullNameUk: 'Р', position: 'Ректор', roles: [{ role: 'SUPER_ADMIN' }] }],
    });
    expect(res.status).toBe(400);
  });

  it('ЄДЕБО sync creates students, groups and dorm rooms; a repeated key is not applied twice', async () => {
    const payload = {
      records: [
        {
          edeboId: `ED-${sfx}`,
          corporateId: `S-${sfx}`,
          email: `student-${sfx}@puet.test`,
          fullNameUk: 'Студент Тест',
          birthDate: '2004-05-01',
          educationLevel: 'BACHELOR',
          instituteCode: 'NNI_DAYTIME',
          groupCode: `KN-${sfx}`,
          courseYear: 2,
          dormitory: { number: 1, room: `1-${sfx}`, floor: 1 },
        },
      ],
    };
    const key = randomUUID();
    const first = await webhook('edebo', 'edebo/students', payload, key);
    expect(await first.json()).toMatchObject({ replayed: false, created: 1 });
    const again = await webhook('edebo', 'edebo/students', payload, key);
    expect(await again.json()).toMatchObject({ replayed: true, created: 1 });
  });

  it('lyceum pupils are always minors', async () => {
    const res = await webhook('lyceum', 'edebo/students', {
      records: [
        { edeboId: `LY-${sfx}`, corporateId: `P-${sfx}`, email: `pupil-${sfx}@puet.test`, fullNameUk: 'Учень Тест', educationLevel: 'LYCEUM', groupCode: `10A-${sfx}`, courseYear: 10 },
      ],
    });
    expect(res.status).toBe(200);
    const pupil = await prisma.user.findUniqueOrThrow({ where: { edeboId: `LY-${sfx}` } });
    expect(pupil.isMinor).toBe(true);
  });

  it('teaching load links the lecturer and the group in the current semester', async () => {
    const res = await webhook('hr', 'teaching-load', {
      semester: { code: `2026-2027-1-${sfx}`, startsOn: '2026-09-01', endsOn: '2027-01-31', isCurrent: true },
      offerings: [
        {
          externalId: `CO-${sfx}`,
          departmentCode: 'COMPUTER_SCIENCE_IT',
          discipline: { code: `ALG-${sfx}`, nameUk: 'Алгоритми', nameEn: 'Algorithms' },
          lecturerHrIds: [`HR-${sfx}`],
          groupCodes: [`KN-${sfx}`],
        },
      ],
    });
    expect(await res.json()).toMatchObject({ created: 1, errors: [] });
  });

  // ── SSO, sessions, CSRF ─────────────────────────────────────────

  let studentCookie: string;

  it('logs a pre-provisioned student in by e-mail and links the OIDC subject', async () => {
    const r = await login({ sub: `sub-student-${sfx}`, email: `student-${sfx}@puet.test`, amr: ['pwd'] });
    expect(r.location).toBe(`${WEB}/chats`);
    studentCookie = r.cookie!;
    const me = await http('/auth/me', { cookie: studentCookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ kind: 'STUDENT', mfaRequired: false });
  });

  it('rejects an IdP identity that matches no provisioned account', async () => {
    const r = await login({ sub: `sub-stranger-${sfx}`, email: `stranger-${sfx}@example.com` });
    expect(r.cookie).toBeUndefined();
    expect(r.location).toBe(`${WEB}/login?error=access_denied`);
  });

  it('CSRF: a cookie-authenticated POST without the web Origin is refused', async () => {
    expect((await http('/auth/logout', { method: 'POST', cookie: studentCookie })).status).toBe(403);
    expect(
      (await http('/auth/logout', { method: 'POST', cookie: studentCookie, headers: { origin: 'https://evil.test' } })).status,
    ).toBe(403);
  });

  it('a student cannot open the admin panel', async () => {
    expect((await http(`/admin/tenants/${mainId}/structure`, { cookie: studentCookie })).status).toBe(403);
  });

  // ── Admin panel ─────────────────────────────────────────────────

  let adminCookie: string;

  it('a SUPER_ADMIN without MFA is sent to step-up and, still without MFA, gets no session', async () => {
    const r = await login({ sub: `sub-admin-${sfx}`, amr: ['pwd'] });
    expect(r.cookie).toBeUndefined();
    expect(r.location).toBe(`${WEB}/login?error=mfa_required`);
    const denial = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'auth.login', actorId: adminId, outcome: 'DENIED' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(denial.reason).toBe('auth.mfa_not_proven acr=- amr=pwd');
  });

  it('a SUPER_ADMIN with MFA manages the structure', async () => {
    const r = await login({ sub: `sub-admin-${sfx}`, amr: ['pwd', 'otp'] });
    adminCookie = r.cookie!;
    const res = await http(`/admin/tenants/${mainId}/structure`, { cookie: adminCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { departments: unknown[]; institutes: unknown[] };
    expect(body.departments.length).toBeGreaterThanOrEqual(17);
    expect(body.institutes.length).toBeGreaterThanOrEqual(7);
  });

  const post = (path: string, body: unknown, method = 'POST') =>
    http(path, { method, cookie: adminCookie, headers: { origin: WEB }, body: JSON.stringify(body) });

  it('separation of duties: no self-grants, no cross-tenant lecturers, scopes must be in the tenant', async () => {
    expect((await post(`/admin/tenants/${mainId}/role-assignments`, { userId: adminId, role: 'RECTORATE' })).status).toBe(403);
    const lecturer = await prisma.user.findUniqueOrThrow({ where: { hrId: `HR-${sfx}` } });
    expect(
      (await post(`/admin/tenants/${mainId}/role-assignments`, { userId: lecturer.id, role: 'LECTURER', crossTenant: true })).status,
    ).toBe(400);
    const lyceum = await prisma.tenant.findUniqueOrThrow({ where: { code: 'PUET_LYCEUM' } });
    const foreignUnit = await prisma.orgUnit.findFirstOrThrow({ where: { tenantId: lyceum.id } });
    expect(
      (await post(`/admin/tenants/${mainId}/role-assignments`, { userId: lecturer.id, role: 'ADMIN_STAFF', orgUnitId: foreignUnit.id })).status,
    ).toBe(400);
    const dept = await prisma.department.findFirstOrThrow({ where: { tenantId: mainId, code: 'COMPUTER_SCIENCE_IT' } });
    const ok = await post(`/admin/tenants/${mainId}/role-assignments`, { userId: lecturer.id, role: 'DEPARTMENT_HEAD', departmentId: dept.id });
    expect(ok.status).toBe(201);
  });

  it('sync-owned roles cannot be revoked in the panel', async () => {
    const lecturer = await prisma.user.findUniqueOrThrow({ where: { hrId: `HR-${sfx}` } });
    const synced = await prisma.roleAssignment.findFirstOrThrow({ where: { userId: lecturer.id, source: 'SYNC' } });
    expect((await http(`/admin/tenants/${mainId}/role-assignments/${synced.id}`, { method: 'DELETE', cookie: adminCookie, headers: { origin: WEB } })).status).toBe(400);
  });

  it('the permission matrix cannot lock SUPER_ADMIN out, and bad ABAC conditions are rejected', async () => {
    expect((await post('/admin/permissions/SUPER_ADMIN', { actions: [] }, 'PUT')).status).toBe(400);
    expect(
      (await post('/admin/policies', { key: `bad-${sfx.toLowerCase()}`, effect: 'DENY', actions: ['file.upload'], condition: { eval: 'x' } })).status,
    ).toBe(400);
    const ok = await post('/admin/policies', {
      key: `no-uploads-${sfx.toLowerCase()}`,
      effect: 'DENY',
      actions: ['file.upload'],
      condition: { eq: [{ var: 'resource.channelType' }, 'GOVERNANCE'] },
      enabled: false,
    });
    expect(ok.status).toBe(201);
  });

  it('the simulator answers with the live engine (shared course allows DM, minor protection denies)', async () => {
    const student = await prisma.user.findUniqueOrThrow({ where: { edeboId: `ED-${sfx}` } });
    const lecturer = await prisma.user.findUniqueOrThrow({ where: { hrId: `HR-${sfx}` } });
    const pupil = await prisma.user.findUniqueOrThrow({ where: { edeboId: `LY-${sfx}` } });
    const sim = async (targetId: string) =>
      (await (await post('/admin/policies/simulate', { userId: student.id, action: 'dm.start', resource: { type: 'user', id: targetId } })).json()) as {
        allowed: boolean;
        reason: string;
      };
    expect(await sim(lecturer.id)).toMatchObject({ allowed: true });
    expect(await sim(pupil.id)).toMatchObject({ allowed: false, reason: 'minor.protection' });
  });

  // ── Offboarding ─────────────────────────────────────────────────

  it('offboarding kills every session at once and blocks re-provisioning', async () => {
    expect((await http('/auth/me', { cookie: studentCookie })).status).toBe(200);
    const res = await webhook('hr', 'offboarding', { records: [{ edeboId: `ED-${sfx}`, reason: 'EXPELLED' }] });
    expect(await res.json()).toMatchObject({ offboarded: 1 });
    expect((await http('/auth/me', { cookie: studentCookie })).status).toBe(401);

    const again = await webhook('edebo', 'edebo/students', {
      records: [{ edeboId: `ED-${sfx}`, corporateId: `S-${sfx}`, email: `student-${sfx}@puet.test`, fullNameUk: 'Студент Тест', educationLevel: 'BACHELOR' }],
    });
    expect(await again.json()).toMatchObject({ errors: [{ index: 0, error: 'person is offboarded' }] });
  });

  it('the audit hash chain is intact after all of the above', async () => {
    const res = await http('/admin/audit/verify?limit=10000', { cookie: adminCookie });
    expect(await res.json()).toMatchObject({ intact: true });
  });
});
