import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WsException } from '@nestjs/websockets';
import type { Principal, Resource } from '@puet/policy-engine';
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
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuditEntry } from '../src/audit/audit-chain';
import type { AuditService } from '../src/audit/audit.service';
import { AuthenticationGuard } from '../src/auth/authentication.guard';
import { Public } from '../src/auth/public.decorator';
import { Authorize } from '../src/authz/authorize.decorator';
import { PolicyGuard } from '../src/authz/policy.guard';
import type { ResourceResolver } from '../src/authz/resource-resolver';
import { PolicyService, type PolicyStore } from '../src/policy/policy.service';
import { DEFAULT_PERMISSION_MATRIX } from '@puet/policy-engine';

const TENANT = '11111111-1111-4111-8111-111111111111';
const MY_CHANNEL = '22222222-2222-4222-8222-222222222222';
const OTHER_CHANNEL = '33333333-3333-4333-8333-333333333333';
const LYCEUM_PUPIL = '44444444-4444-4444-8444-444444444444';

class Handlers {
  @Authorize(Action.MESSAGE_READ, { type: ResourceType.CHANNEL, idField: 'channelId' })
  readMessages() {}

  @Authorize(Action.FILE_DOWNLOAD, { type: ResourceType.CHANNEL, idField: 'channelId' })
  download() {}

  @Authorize(Action.DM_START, { type: ResourceType.USER, idField: 'userId' })
  startDm() {}

  notAnnotated() {}

  @Public()
  health() {}
}

const student: Principal = {
  userId: '55555555-5555-4555-8555-555555555555',
  tenantId: TENANT,
  kind: PrincipalKind.STUDENT,
  status: AccountStatus.ACTIVE,
  roles: [{ role: RoleCode.STUDENT, tenantId: TENANT }],
  isMinor: false,
  mfaVerified: false,
  instituteIds: [],
  departmentIds: [],
  orgUnitIds: [],
  academicGroupIds: ['g1'],
  activeCourseOfferingIds: [],
};

const channelResource = (id: string, isMember: boolean, extra: Partial<Resource> = {}): Resource => ({
  type: ResourceType.CHANNEL,
  id,
  tenantId: TENANT,
  channelType: ChannelType.COURSE,
  e2eeMode: E2eeMode.DISABLED,
  isMember,
  ...(isMember ? { memberRole: MemberRole.MEMBER } : {}),
  ...extra,
});

/** Simulates the DB: the student is a member of MY_CHANNEL only. */
const fakeResolvers: ResourceResolver[] = [
  {
    types: [ResourceType.CHANNEL],
    async resolve(_t, id) {
      if (id === MY_CHANNEL) return channelResource(MY_CHANNEL, true);
      if (id === OTHER_CHANNEL) return channelResource(OTHER_CHANNEL, false);
      return null;
    },
  },
  {
    types: [ResourceType.USER],
    async resolve(_t, id) {
      if (id !== LYCEUM_PUPIL) return null;
      return {
        type: ResourceType.USER,
        id,
        tenantId: 'lyceum',
        target: {
          userId: id,
          tenantId: 'lyceum',
          kind: PrincipalKind.STUDENT,
          status: AccountStatus.ACTIVE,
          isMinor: true,
          roles: [RoleCode.STUDENT],
          instituteIds: [],
          academicGroupIds: ['lyc'],
          activeCourseOfferingIds: [],
        },
      };
    },
  },
];

const store: PolicyStore = {
  load: async () => ({ matrix: DEFAULT_PERMISSION_MATRIX, policies: [], phoneAccessOrgUnitIds: [] }),
};

function httpContext(handler: keyof Handlers, req: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => Handlers.prototype[handler],
    getClass: () => Handlers,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function wsContext(handler: keyof Handlers, client: Record<string, unknown>, data: unknown): ExecutionContext {
  return {
    getType: () => 'ws',
    getHandler: () => Handlers.prototype[handler],
    getClass: () => Handlers,
    switchToWs: () => ({ getClient: () => client, getData: () => data }),
  } as unknown as ExecutionContext;
}

describe('PolicyGuard', () => {
  let audit: AuditEntry[];
  let guard: PolicyGuard;

  beforeEach(() => {
    audit = [];
    const auditService = { record: async (e: AuditEntry) => void audit.push(e) } as unknown as AuditService;
    guard = new PolicyGuard(new Reflector(), new PolicyService(store), auditService, fakeResolvers);
  });

  it('allows a member and attaches the resolved resource', async () => {
    const req: Record<string, unknown> = { principal: student, params: { channelId: MY_CHANNEL } };
    await expect(guard.canActivate(httpContext('readMessages', req))).resolves.toBe(true);
    expect((req.authz as { resource: Resource }).resource.id).toBe(MY_CHANNEL);
  });

  it('IDOR: denies reading a channel the caller is not a member of, and audits it', async () => {
    const req = { principal: student, params: { channelId: OTHER_CHANNEL } };
    await expect(guard.canActivate(httpContext('readMessages', req))).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: 'DENIED', reason: 'membership.required', resourceId: OTHER_CHANNEL });
  });

  it('answers a non-existent id exactly like a forbidden one (no enumeration)', async () => {
    const missing = '66666666-6666-4666-8666-666666666666';
    const err = await guard
      .canActivate(httpContext('readMessages', { principal: student, params: { channelId: missing } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).message).toBe('Access denied');
    expect(audit[0]?.reason).toBe('resource.not_found');
  });

  it('rejects malformed ids before touching the database', async () => {
    const req = { principal: student, params: { channelId: "1' OR '1'='1" } };
    await expect(guard.canActivate(httpContext('readMessages', req))).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit[0]?.reason).toBe('resource.invalid_id');
  });

  it('ignores ids smuggled in the request body', async () => {
    const req = { principal: student, params: {}, body: { channelId: MY_CHANNEL } };
    await expect(guard.canActivate(httpContext('readMessages', req))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails closed for handlers without @Authorize', async () => {
    const req = { principal: student, params: {} };
    await expect(guard.canActivate(httpContext('notAnnotated', req))).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit[0]?.reason).toBe('route.not_annotated');
  });

  it('lets @Public routes through without a principal', async () => {
    await expect(guard.canActivate(httpContext('health', {}))).resolves.toBe(true);
  });

  it('requires a principal', async () => {
    const req = { params: { channelId: MY_CHANNEL } };
    await expect(guard.canActivate(httpContext('readMessages', req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('audits sensitive allowed actions (file download)', async () => {
    const req = { principal: student, params: { channelId: MY_CHANNEL } };
    await guard.canActivate(httpContext('download', req));
    expect(audit[0]).toMatchObject({ outcome: 'SUCCESS', action: Action.FILE_DOWNLOAD });
  });

  it('fails closed when the audit log cannot record a sensitive action', async () => {
    const broken = { record: async () => Promise.reject(new Error('db down')) } as unknown as AuditService;
    const g = new PolicyGuard(new Reflector(), new PolicyService(store), broken, fakeResolvers);
    const req = { principal: student, params: { channelId: MY_CHANNEL } };
    await expect(g.canActivate(httpContext('download', req))).rejects.toThrow();
  });

  it('minor isolation: denies an adult student a DM with a lyceum pupil', async () => {
    const req = { principal: student, params: { userId: LYCEUM_PUPIL } };
    await expect(guard.canActivate(httpContext('startDm', req))).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit[0]?.reason).toBe('minor.protection');
  });

  describe('WebSocket events', () => {
    it('allows a member to subscribe to their channel', async () => {
      const client = { data: { principal: student } };
      await expect(guard.canActivate(wsContext('readMessages', client, { channelId: MY_CHANNEL }))).resolves.toBe(true);
    });

    it('denies a non-member with a WsException', async () => {
      const client = { data: { principal: student } };
      await expect(
        guard.canActivate(wsContext('readMessages', client, { channelId: OTHER_CHANNEL })),
      ).rejects.toBeInstanceOf(WsException);
    });

    it('denies an unauthenticated socket', async () => {
      await expect(
        guard.canActivate(wsContext('readMessages', { data: {} }, { channelId: MY_CHANNEL })),
      ).rejects.toBeInstanceOf(WsException);
    });
  });
});

describe('AuthenticationGuard', () => {
  const guard = new AuthenticationGuard(new Reflector());

  it('rejects requests without a principal', () => {
    expect(() => guard.canActivate(httpContext('readMessages', {}))).toThrow(UnauthorizedException);
  });

  it('rejects offboarded accounts immediately', () => {
    const req = { principal: { ...student, status: AccountStatus.OFFBOARDED } };
    expect(() => guard.canActivate(httpContext('readMessages', req))).toThrow(UnauthorizedException);
  });

  it('accepts an active principal and public routes', () => {
    expect(guard.canActivate(httpContext('readMessages', { principal: student }))).toBe(true);
    expect(guard.canActivate(httpContext('health', {}))).toBe(true);
  });
});
