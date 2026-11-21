import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@puet/policy-engine';
import { AccountStatus } from '@puet/shared';
import { parse as parseCookie } from 'cookie';
import { PrincipalFactory } from '../auth/principal.factory';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { SESSION_STORE, type SessionData, type SessionStore } from './session.store';

/** `__Host-` prefix: Secure, Path=/, no Domain. The browser refuses to let subdomains overwrite it. */
export const SESSION_COOKIE = '__Host-puet_sid';
/** Non-secure name for local http development only. */
export const DEV_SESSION_COOKIE = 'puet_sid';

export interface ResolvedSession {
  token: string;
  data: SessionData;
  principal: Principal;
}

/**
 * Turns a session cookie into a Principal. Used by the HTTP middleware and by the
 * WebSocket gateway handshake (Phase 3), so both transports authenticate the same way.
 */
@Injectable()
export class SessionAuthService {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(PrincipalFactory) private readonly principals: PrincipalFactory,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  cookieName(): string {
    return this.config.production ? SESSION_COOKIE : DEV_SESSION_COOKIE;
  }

  tokenFromCookieHeader(header: string | undefined): string | undefined {
    if (!header) return undefined;
    return parseCookie(header)[this.cookieName()];
  }

  async resolve(token: string | undefined, now = Date.now()): Promise<ResolvedSession | null> {
    if (!token) return null;
    const data = await this.store.get(token);
    if (!data) return null;

    const { absoluteMs, idleMs } = this.config.session;
    if (now - data.createdAt > absoluteMs || now - data.lastSeenAt > idleMs) {
      await this.store.destroy(token);
      return null;
    }

    const built = await this.principals.build(data.userId, { mfaVerified: data.mfaVerified });
    // Offboarding bumps session_epoch: every session issued before it dies here.
    if (!built || built.sessionEpoch !== data.epoch || built.principal.status !== AccountStatus.ACTIVE) {
      await this.store.destroy(token);
      return null;
    }

    const touched = { ...data, lastSeenAt: now };
    const remainingAbsolute = absoluteMs - (now - data.createdAt);
    await this.store.touch(token, touched, Math.min(idleMs, remainingAbsolute));
    return { token, data: touched, principal: built.principal };
  }
}
