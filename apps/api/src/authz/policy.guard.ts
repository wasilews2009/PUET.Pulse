import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WsException } from '@nestjs/websockets';
import type { Decision, Principal, Resource } from '@puet/policy-engine';
import { Action } from '@puet/shared';
import { AuditService } from '../audit/audit.service';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import type { AuthenticatedRequest, AuthenticatedSocket, RequestAuthContext } from '../auth/principal';
import { PolicyService } from '../policy/policy.service';
import { AUTHORIZE_KEY, type AuthorizeMetadata } from './authorize.decorator';
import { RESOURCE_RESOLVERS, type ResourceResolver } from './resource-resolver';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Allowed actions that are always written to the audit log (denials are always logged). */
const AUDITED_ALLOW: ReadonlySet<string> = new Set([
  Action.FILE_DOWNLOAD,
  Action.FILE_VIEW,
  Action.DOCUMENT_SIGN,
  Action.DOCUMENT_APPROVE,
  Action.ROLE_ASSIGN,
  Action.POLICY_MANAGE,
  Action.STRUCTURE_MANAGE,
  Action.AUDIT_READ,
  Action.CERTIFICATE_ISSUE,
  Action.CERTIFICATE_REVOKE,
  Action.USER_PHONE_READ,
  Action.USER_DORM_ROOM_READ,
  Action.EMERGENCY_ALERT_SEND,
  Action.BROADCAST_PUBLISH,
  Action.CHANNEL_MEMBERS_MANAGE,
  Action.CHANNEL_ARCHIVE,
]);

interface Extracted {
  principal?: Principal;
  carrier: RequestAuthContext;
  input: (field: string) => unknown;
  ip?: string;
  isWs: boolean;
}

/**
 * Second global guard: zero-trust authorization for every HTTP route and
 * WebSocket event.
 *
 *  - fail-closed: a handler without @Authorize (and not @Public) is denied;
 *  - the resource is loaded server-side by id, with membership computed for the
 *    caller (IDOR prevention);
 *  - RBAC + ABAC decision from the policy engine;
 *  - every denial and every sensitive allow is written to the immutable audit log;
 *  - denials are uniform (403 "Access denied"): no hint whether the id exists.
 */
@Injectable()
export class PolicyGuard implements CanActivate {
  private readonly logger = new Logger(PolicyGuard.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RESOURCE_RESOLVERS) private readonly resolvers: ResourceResolver[],
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const ex = this.extract(context);
    if (!ex.principal) throw ex.isWs ? new WsException('Unauthorized') : new UnauthorizedException();
    const principal = ex.principal;

    const meta = this.reflector.getAllAndOverride<AuthorizeMetadata | undefined>(AUTHORIZE_KEY, targets);
    if (!meta) {
      this.logger.error(`Handler ${context.getClass().name}.${context.getHandler().name} has no @Authorize`);
      return this.reject(ex, principal, undefined, undefined, 'route.not_annotated');
    }

    let id: string | undefined;
    if (meta.resource.idField) {
      const raw = ex.input(meta.resource.idField);
      if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
        return this.reject(ex, principal, meta, undefined, 'resource.invalid_id');
      }
      id = raw;
    }

    const resolver = this.resolvers.find((r) => r.types.includes(meta.resource.type));
    if (!resolver) return this.reject(ex, principal, meta, id, 'resource.no_resolver');

    const resource = await resolver.resolve(meta.resource.type, id, principal);
    if (!resource) return this.reject(ex, principal, meta, id, 'resource.not_found');

    const decision = await this.policy.evaluate(principal, meta.action, resource, {
      now: new Date(),
      ...(ex.ip ? { ip: ex.ip } : {}),
    });

    if (!decision.allowed) return this.reject(ex, principal, meta, id, decision.reason, resource, decision);

    if (AUDITED_ALLOW.has(meta.action)) {
      try {
        await this.audit.record({
          actorId: principal.userId,
          tenantId: resource.tenantId,
          action: meta.action,
          resourceType: resource.type,
          resourceId: id ?? null,
          outcome: 'SUCCESS',
          reason: decision.reason,
          ip: ex.ip ?? null,
          requestId: ex.carrier.requestId ?? null,
        });
      } catch (err) {
        // Sensitive actions must not happen without an audit trail.
        this.logger.error('Audit write failed for a sensitive action', err as Error);
        if (ex.isWs) throw new WsException('Service unavailable');
        throw new ServiceUnavailableException();
      }
    }

    ex.carrier.authz = { resource, decision };
    return true;
  }

  private async reject(
    ex: Extracted,
    principal: Principal,
    meta: AuthorizeMetadata | undefined,
    id: string | undefined,
    reason: string,
    resource?: Resource,
    decision?: Decision,
  ): Promise<never> {
    try {
      await this.audit.record({
        actorId: principal.userId,
        tenantId: resource?.tenantId ?? principal.tenantId,
        action: meta?.action ?? 'unknown',
        resourceType: meta?.resource.type ?? null,
        resourceId: id ?? null,
        outcome: 'DENIED',
        reason,
        ip: ex.ip ?? null,
        requestId: ex.carrier.requestId ?? null,
        metadata: decision?.policyId ? { policyId: decision.policyId } : null,
      });
    } catch (err) {
      this.logger.error('Audit write failed for a denial', err as Error);
    }
    if (ex.isWs) throw new WsException('Access denied');
    throw new ForbiddenException('Access denied');
  }

  private extract(context: ExecutionContext): Extracted {
    if (context.getType() === 'ws') {
      const ws = context.switchToWs();
      const client = ws.getClient<AuthenticatedSocket>();
      const data = ws.getData<unknown>();
      return {
        principal: client.data?.principal,
        carrier: client.data ?? (client.data = {}),
        input: (field) =>
          data !== null && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, field)
            ? (data as Record<string, unknown>)[field]
            : undefined,
        ...(client.handshake?.address ? { ip: client.handshake.address } : {}),
        isWs: true,
      };
    }
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return {
      principal: req.principal,
      carrier: req,
      // Ids come from the path or query only, never from the body.
      input: (field) => req.params?.[field] ?? req.query?.[field],
      ...(req.ip ? { ip: req.ip } : {}),
      isWs: false,
    };
  }
}
