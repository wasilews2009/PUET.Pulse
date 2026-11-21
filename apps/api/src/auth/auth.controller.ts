import { Controller, Get, HttpCode, Inject, Logger, Post, Query, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { MFA_REQUIRED_ROLES, Action, ResourceType } from '@puet/shared';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { SessionAuthService } from '../session/session-auth.service';
import { Authorize } from '../authz/authorize.decorator';
import { AuthService } from './auth.service';
import type { AuthenticatedRequest } from './principal';
import { Public } from './public.decorator';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionAuthService) private readonly sessions: SessionAuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('login')
  async login(@Query('returnTo') returnTo: unknown, @Res() res: Response) {
    let url: string;
    try {
      url = await this.auth.beginLogin(returnTo);
    } catch (err) {
      new Logger(AuthController.name).error('Identity provider unreachable', err as Error);
      throw new ServiceUnavailableException('Single sign-on is temporarily unavailable');
    }
    res.redirect(302, url);
  }

  @Public()
  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string') params[k] = v;

    const result = await this.auth.completeLogin(params, {
      ...(req.ip ? { ip: req.ip } : {}),
      ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
      ...((req as unknown as AuthenticatedRequest).requestId
        ? { requestId: (req as unknown as AuthenticatedRequest).requestId! }
        : {}),
    });

    if (result.kind === 'step-up') return res.redirect(302, result.url);
    if (result.kind === 'rejected') {
      // Same message for every reason: no account enumeration.
      return res.redirect(302, `${this.config.webOrigin}/login?error=access_denied`);
    }
    res.cookie(this.sessions.cookieName(), result.token, {
      httpOnly: true,
      secure: this.config.production,
      sameSite: 'lax',
      path: '/',
      maxAge: this.config.session.absoluteMs,
    });
    return res.redirect(302, `${this.config.webOrigin}${result.returnTo}`);
  }

  /** Public so an expired session can still clear its cookie. CSRF-checked by the session middleware. */
  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = req as unknown as AuthenticatedRequest & { sessionToken?: string };
    const token = r.sessionToken ?? this.sessions.tokenFromCookieHeader(req.headers.cookie);
    const actor = r.principal ? { userId: r.principal.userId, tenantId: r.principal.tenantId } : undefined;
    const endSessionUrl = await this.auth.logout(token, actor, req.ip);
    res.clearCookie(this.sessions.cookieName(), { path: '/', secure: this.config.production, httpOnly: true });
    return { endSessionUrl: endSessionUrl ?? null };
  }

  @Get('me')
  @Authorize(Action.SESSION_READ, { type: ResourceType.SESSION })
  me(@Req() req: AuthenticatedRequest) {
    const p = req.principal!;
    return {
      userId: p.userId,
      tenantId: p.tenantId,
      kind: p.kind,
      isMinor: p.isMinor,
      roles: p.roles.map((r) => ({ role: r.role, scope: r.scope ?? {}, expiresAt: r.expiresAt ?? null })),
      mfaVerified: p.mfaVerified,
      mfaRequired: p.roles.some((r) => MFA_REQUIRED_ROLES.includes(r.role)),
    };
  }
}
