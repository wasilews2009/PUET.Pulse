import { createHash, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';

export const SESSION_STORE = Symbol('SESSION_STORE');

export interface SessionData {
  userId: string;
  /** users.session_epoch at login. A mismatch means the user was offboarded / force-logged-out. */
  epoch: number;
  mfaVerified: boolean;
  createdAt: number;
  lastSeenAt: number;
  ip?: string;
  userAgent?: string;
}

/** PKCE / state / nonce for an in-flight OIDC login. One-time use. */
export interface OidcTransaction {
  codeVerifier: string;
  nonce: string;
  returnTo: string;
  stepUp: boolean;
}

export interface SessionStore {
  /** Returns the opaque token to put in the cookie. Only its SHA-256 is stored. */
  create(data: SessionData, ttlMs: number): Promise<string>;
  get(token: string): Promise<SessionData | null>;
  touch(token: string, data: SessionData, ttlMs: number): Promise<void>;
  destroy(token: string): Promise<void>;
  destroyAllForUser(userId: string): Promise<number>;
  putTransaction(state: string, tx: OidcTransaction, ttlMs: number): Promise<void>;
  takeTransaction(state: string): Promise<OidcTransaction | null>;
}

/** 256-bit random token from the OS CSPRNG. */
export const newToken = (): string => randomBytes(32).toString('base64url');
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** Stable id of a session (the SHA-256 the store keys it by), for data bound to one login. */
export const sessionIdOf = (token: string): string => digest(token);

/** Redis-backed store: a Redis dump never contains a usable session token. */
export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: Redis) {}

  async create(data: SessionData, ttlMs: number): Promise<string> {
    const token = newToken();
    const id = digest(token);
    await this.redis
      .multi()
      .set(`sess:${id}`, JSON.stringify(data), 'PX', ttlMs)
      .sadd(`user-sess:${data.userId}`, id)
      .exec();
    return token;
  }

  async get(token: string): Promise<SessionData | null> {
    if (!TOKEN_RE.test(token)) return null;
    const raw = await this.redis.get(`sess:${digest(token)}`);
    return raw ? (JSON.parse(raw) as SessionData) : null;
  }

  async touch(token: string, data: SessionData, ttlMs: number): Promise<void> {
    await this.redis.set(`sess:${digest(token)}`, JSON.stringify(data), 'PX', ttlMs, 'XX');
  }

  async destroy(token: string): Promise<void> {
    if (!TOKEN_RE.test(token)) return;
    const id = digest(token);
    const raw = await this.redis.get(`sess:${id}`);
    const multi = this.redis.multi().del(`sess:${id}`);
    if (raw) multi.srem(`user-sess:${(JSON.parse(raw) as SessionData).userId}`, id);
    await multi.exec();
  }

  async destroyAllForUser(userId: string): Promise<number> {
    const ids = await this.redis.smembers(`user-sess:${userId}`);
    if (ids.length === 0) return 0;
    await this.redis
      .multi()
      .del(...ids.map((id) => `sess:${id}`))
      .del(`user-sess:${userId}`)
      .exec();
    return ids.length;
  }

  async putTransaction(state: string, tx: OidcTransaction, ttlMs: number): Promise<void> {
    await this.redis.set(`oidc:${digest(state)}`, JSON.stringify(tx), 'PX', ttlMs);
  }

  async takeTransaction(state: string): Promise<OidcTransaction | null> {
    const raw = await this.redis.getdel(`oidc:${digest(state)}`);
    return raw ? (JSON.parse(raw) as OidcTransaction) : null;
  }
}

/** In-memory store for tests and single-process development. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, { data: SessionData; expires: number }>();
  private readonly txs = new Map<string, { tx: OidcTransaction; expires: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async create(data: SessionData, ttlMs: number): Promise<string> {
    const token = newToken();
    this.sessions.set(digest(token), { data, expires: this.now() + ttlMs });
    return token;
  }

  async get(token: string): Promise<SessionData | null> {
    const entry = this.sessions.get(digest(token));
    if (!entry || entry.expires <= this.now()) return null;
    return entry.data;
  }

  async touch(token: string, data: SessionData, ttlMs: number): Promise<void> {
    const id = digest(token);
    if (this.sessions.has(id)) this.sessions.set(id, { data, expires: this.now() + ttlMs });
  }

  async destroy(token: string): Promise<void> {
    this.sessions.delete(digest(token));
  }

  async destroyAllForUser(userId: string): Promise<number> {
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.data.userId === userId) {
        this.sessions.delete(id);
        n++;
      }
    }
    return n;
  }

  async putTransaction(state: string, tx: OidcTransaction, ttlMs: number): Promise<void> {
    this.txs.set(digest(state), { tx, expires: this.now() + ttlMs });
  }

  async takeTransaction(state: string): Promise<OidcTransaction | null> {
    const id = digest(state);
    const entry = this.txs.get(id);
    this.txs.delete(id);
    return entry && entry.expires > this.now() ? entry.tx : null;
  }
}
