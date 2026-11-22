import { ForbiddenException, Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/principal';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { TrustIntakeService } from '../trust/trust-intake.service';
import { SessionAuthService } from './session-auth.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Runs before the guards on every non-integration route:
 *  - assigns a request id;
 *  - CSRF: a state-changing request that carries the session cookie must come
 *    from the web origin (Origin header), on top of SameSite=Lax;
 *  - resolves the session cookie into req.principal (or leaves it empty);
 *  - X-Pulse-Persona: acts as the pseudonym of one of the caller's own anonymous
 *    appeals (Phase 9). Anything that is not exactly that is a uniform 403.
 */
@Injectable()
export class SessionMiddleware implements NestMiddleware {
  constructor(
    @Inject(SessionAuthService) private readonly sessions: SessionAuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TrustIntakeService) private readonly trust: TrustIntakeService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const r = req as unknown as AuthenticatedRequest & { sessionToken?: string };
    r.requestId = randomUUID();
    res.setHeader('X-Request-Id', r.requestId);

    const token = this.sessions.tokenFromCookieHeader(req.headers.cookie);
    if (token && !SAFE_METHODS.has(req.method) && req.headers.origin !== this.config.webOrigin) {
      return next(new ForbiddenException('Access denied'));
    }

    try {
      const resolved = await this.sessions.resolve(token);
      if (resolved) {
        r.principal = resolved.principal;
        r.sessionToken = resolved.token;
      }
      const persona = req.headers['x-pulse-persona'];
      if (persona !== undefined) {
        if (!resolved || typeof persona !== 'string' || !UUID.test(persona)) return next(new ForbiddenException('Access denied'));
        r.principal = await this.trust.persona(resolved.principal, persona);
      }
      next();
    } catch (err) {
      next(err);
    }
  }
}
