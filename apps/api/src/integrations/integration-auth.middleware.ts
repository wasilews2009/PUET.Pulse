import { Inject, Injectable, Logger, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import type { Principal } from '@puet/policy-engine';
import { AccountStatus, PrincipalKind, RoleCode } from '@puet/shared';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../auth/principal';
import { APP_CONFIG, type AppConfig, type IntegrationClientConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { SIGNATURE_HEADER, verifySignature } from './hmac';

export const CLIENT_ID_HEADER = 'x-puet-client';

export type IntegrationRequest = AuthenticatedRequest & {
  rawBody?: Buffer;
  integrationClient?: IntegrationClientConfig;
};

/**
 * Authenticates /integrations/* calls with an HMAC signature over the raw body
 * and turns the client into a SERVICE_BOT principal bound to one tenant. The
 * policy guard then still checks @Authorize(SYNC_INGEST). Cookies are ignored here.
 */
@Injectable()
export class IntegrationAuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(IntegrationAuthMiddleware.name);
  private readonly tenantIds = new Map<string, string>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const r = req as unknown as IntegrationRequest;
    r.requestId = randomUUID();
    res.setHeader('X-Request-Id', r.requestId);

    const clientId = req.headers[CLIENT_ID_HEADER];
    const client = typeof clientId === 'string' ? this.config.integrations.clients.get(clientId) : undefined;
    const check = client
      ? verifySignature({
          secret: client.secret,
          header: req.headers[SIGNATURE_HEADER] as string | undefined,
          body: r.rawBody,
          nowSeconds: Math.floor(Date.now() / 1000),
          toleranceSeconds: this.config.integrations.toleranceSeconds,
        })
      : { ok: false as const, reason: 'client.unknown' };

    if (!check.ok || !client) {
      this.logger.warn(`Rejected integration call: ${check.ok ? 'client.unknown' : check.reason}`);
      return next(new UnauthorizedException());
    }

    try {
      const tenantId = await this.tenantId(client.tenantCode);
      const principal: Principal = {
        userId: client.id,
        tenantId,
        kind: PrincipalKind.SERVICE_BOT,
        status: AccountStatus.ACTIVE,
        roles: [{ role: RoleCode.INTEGRATION, tenantId }],
        isMinor: false,
        mfaVerified: false,
        instituteIds: [],
        departmentIds: [],
        orgUnitIds: [],
        academicGroupIds: [],
        activeCourseOfferingIds: [],
      };
      r.principal = principal;
      r.integrationClient = client;
      next();
    } catch (err) {
      next(err);
    }
  }

  private async tenantId(code: IntegrationClientConfig['tenantCode']): Promise<string> {
    const cached = this.tenantIds.get(code);
    if (cached) return cached;
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { code }, select: { id: true } });
    this.tenantIds.set(code, tenant.id);
    return tenant.id;
  }
}
