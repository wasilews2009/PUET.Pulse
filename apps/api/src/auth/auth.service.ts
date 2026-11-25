import { Inject, Injectable } from '@nestjs/common';
import { AccountStatus } from '@puet/shared';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { SESSION_STORE, sessionIdOf, type SessionStore } from '../session/session.store';
import { idTokenProvesMfa, requiresMfa, safeReturnTo } from './mfa';
import { OIDC_PROVIDER, oidcGenerators, type IdTokenClaims, type OidcProvider } from './oidc.service';
import { PrincipalFactory } from './principal.factory';

const TX_TTL_MS = 10 * 60_000;

export type CallbackResult =
  | { kind: 'session'; token: string; returnTo: string; mfaVerified: boolean }
  | { kind: 'step-up'; url: string }
  | { kind: 'rejected'; reason: string };

/**
 * SSO login. Accounts are created only by the ЄДЕБО / HR sync: an IdP identity
 * that matches no active, pre-provisioned user is rejected (no self-registration).
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(OIDC_PROVIDER) private readonly oidc: OidcProvider,
    @Inject(SESSION_STORE) private readonly sessions: SessionStore,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PrincipalFactory) private readonly principals: PrincipalFactory,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PushService) private readonly push: PushService,
  ) {}

  async beginLogin(returnTo: unknown, stepUp = false): Promise<string> {
    const state = oidcGenerators.state();
    const nonce = oidcGenerators.nonce();
    const codeVerifier = oidcGenerators.codeVerifier();
    await this.sessions.putTransaction(
      state,
      { codeVerifier, nonce, returnTo: safeReturnTo(returnTo), stepUp },
      TX_TTL_MS,
    );
    return this.oidc.authorizationUrl({
      state,
      nonce,
      codeChallenge: oidcGenerators.codeChallenge(codeVerifier),
      ...(stepUp ? { acr: this.config.oidc.stepUpAcr } : {}),
    });
  }

  async completeLogin(
    params: Record<string, string>,
    meta: { ip?: string; userAgent?: string; requestId?: string },
  ): Promise<CallbackResult> {
    const state = params.state;
    if (!state) return this.reject('oidc.missing_state', meta);
    const tx = await this.sessions.takeTransaction(state);
    if (!tx) return this.reject('oidc.unknown_state', meta);

    let claims: IdTokenClaims;
    try {
      claims = await this.oidc.exchange({ params, state, nonce: tx.nonce, codeVerifier: tx.codeVerifier });
    } catch {
      return this.reject('oidc.token_invalid', meta);
    }

    const user = await this.linkUser(claims);
    if (!user) return this.reject('auth.unknown_identity', meta);
    if (user.status !== AccountStatus.ACTIVE) return this.reject('auth.account_inactive', meta, user.id);

    const mfaVerified = idTokenProvesMfa(claims, this.config.oidc);
    const built = await this.principals.build(user.id, { mfaVerified });
    if (!built) return this.reject('auth.unknown_identity', meta);

    if (!mfaVerified && requiresMfa(built.principal.roles) && !tx.stepUp) {
      return { kind: 'step-up', url: await this.beginLogin(tx.returnTo, true) };
    }

    const now = Date.now();
    const token = await this.sessions.create(
      {
        userId: user.id,
        epoch: built.sessionEpoch,
        mfaVerified,
        createdAt: now,
        lastSeenAt: now,
        ...(meta.ip ? { ip: meta.ip } : {}),
        ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 256) } : {}),
      },
      this.config.session.idleMs,
    );

    await this.audit.record({
      actorId: user.id,
      tenantId: user.tenantId,
      action: 'auth.login',
      outcome: 'SUCCESS',
      reason: mfaVerified ? 'mfa' : 'single_factor',
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      requestId: meta.requestId ?? null,
    });
    return { kind: 'session', token, returnTo: tx.returnTo, mfaVerified };
  }

  async logout(token: string | undefined, actor?: { userId: string; tenantId: string }, ip?: string) {
    if (token) {
      await this.sessions.destroy(token);
      // Signed out on this phone: it stops receiving notifications at once.
      await this.push.removeForSession(sessionIdOf(token));
    }
    if (actor) {
      await this.audit.record({
        actorId: actor.userId,
        tenantId: actor.tenantId,
        action: 'auth.logout',
        outcome: 'SUCCESS',
        ip: ip ?? null,
      });
    }
    return this.oidc.endSessionUrl().catch(() => undefined);
  }

  /** Match by OIDC subject; on first login link a pre-provisioned account by e-mail. */
  private async linkUser(claims: IdTokenClaims) {
    const select = { id: true, tenantId: true, status: true } as const;
    const bySub = await this.prisma.user.findUnique({ where: { oidcSubject: claims.sub }, select });
    if (bySub) return bySub;
    if (typeof claims.email !== 'string' || claims.email_verified === false) return null;
    const email = claims.email.trim().toLowerCase();
    const byEmail = await this.prisma.user.findFirst({ where: { email, oidcSubject: null }, select });
    if (!byEmail) return null;
    await this.prisma.user.update({ where: { id: byEmail.id }, data: { oidcSubject: claims.sub } });
    return byEmail;
  }

  private async reject(
    reason: string,
    meta: { ip?: string; userAgent?: string; requestId?: string },
    actorId?: string,
  ): Promise<CallbackResult> {
    await this.audit.record({
      actorId: actorId ?? null,
      action: 'auth.login',
      outcome: 'DENIED',
      reason,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      requestId: meta.requestId ?? null,
    });
    return { kind: 'rejected', reason };
  }
}
