import { ForbiddenException, Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/principal';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { SessionAuthService } from './session-auth.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Runs before the guards on every non-integration route:
 *  - assigns a request id;
 *  - CSRF: a state-changing request that carries the session cookie must come
 *    from the web origin (Origin header), on top of SameSite=Lax;
 *  - resolves the session cookie into req.principal (or leaves it empty).
 */
@Injectable()
export class SessionMiddleware implements NestMiddleware {
  constructor(
    @Inject(SessionAuthService) private readonly sessions: SessionAuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
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
      next();
    } catch (err) {
      next(err);
    }
  }
}
