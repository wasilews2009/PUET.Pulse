import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';

export const PRESENCE_TRACKER = Symbol('PRESENCE_TRACKER');

/**
 * Who has the messenger open right now. Each open socket is a lease that the
 * gateway renews every minute, so a crashed API instance cannot leave anyone
 * "online" for longer than LEASE_MS. Presence is informational only: no access
 * decision ever depends on it, so lookups fail soft (nobody is shown online).
 */
export interface PresenceTracker {
  connected(userId: string, socketId: string): Promise<void>;
  disconnected(userId: string, socketId: string): Promise<void>;
  /** Renews the leases of the sockets this instance still holds. */
  renew(sockets: readonly { userId: string; socketId: string }[]): Promise<void>;
  /** The subset of userIds with at least one live socket. */
  onlineOf(userIds: readonly string[]): Promise<Set<string>>;
}

/** Longer than two renewal rounds of the gateway (60 s), so a slow round does not flicker. */
export const LEASE_MS = 150_000;

const key = (userId: string) => `puet:presence:${userId}`;

export class MemoryPresenceTracker implements PresenceTracker {
  private readonly leases = new Map<string, Map<string, number>>();

  constructor(private readonly now: () => number = Date.now) {}

  async connected(userId: string, socketId: string) {
    const m = this.leases.get(userId) ?? new Map<string, number>();
    m.set(socketId, this.now() + LEASE_MS);
    this.leases.set(userId, m);
  }

  async disconnected(userId: string, socketId: string) {
    this.leases.get(userId)?.delete(socketId);
  }

  async renew(sockets: readonly { userId: string; socketId: string }[]) {
    for (const s of sockets) await this.connected(s.userId, s.socketId);
  }

  async onlineOf(userIds: readonly string[]) {
    const now = this.now();
    return new Set(userIds.filter((id) => [...(this.leases.get(id)?.values() ?? [])].some((until) => until > now)));
  }
}

/** One sorted set per person: member = socket id, score = lease expiry (ms). */
export class RedisPresenceTracker implements PresenceTracker {
  private readonly logger = new Logger(RedisPresenceTracker.name);

  constructor(private readonly redis: Redis) {}

  async connected(userId: string, socketId: string) {
    await this.renew([{ userId, socketId }]);
  }

  async disconnected(userId: string, socketId: string) {
    try {
      await this.redis.zrem(key(userId), socketId);
    } catch (err) {
      this.logger.warn(`Presence update failed: ${(err as Error).message}`);
    }
  }

  async renew(sockets: readonly { userId: string; socketId: string }[]) {
    if (!sockets.length) return;
    try {
      const now = Date.now();
      const p = this.redis.pipeline();
      for (const s of sockets) {
        p.zadd(key(s.userId), now + LEASE_MS, s.socketId);
        p.zremrangebyscore(key(s.userId), '-inf', now);
        p.pexpire(key(s.userId), LEASE_MS);
      }
      await p.exec();
    } catch (err) {
      this.logger.warn(`Presence update failed: ${(err as Error).message}`);
    }
  }

  async onlineOf(userIds: readonly string[]) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return new Set<string>();
    try {
      const now = Date.now();
      const p = this.redis.pipeline();
      for (const id of ids) p.zcount(key(id), now, '+inf');
      const res = (await p.exec()) ?? [];
      return new Set(ids.filter((_, i) => Number(res[i]?.[1] ?? 0) > 0));
    } catch (err) {
      this.logger.warn(`Presence lookup failed: ${(err as Error).message}`);
      return new Set<string>();
    }
  }
}

/** Statuses a person sets by hand; they are shown as chosen until they expire. */
const MANUAL = new Set(['IN_CLASS', 'IN_COUNCIL', 'ON_BUSINESS_TRIP', 'DO_NOT_DISTURB']);

/**
 * What colleagues see: a hand-set status («На парі», «Не турбувати» …) while it
 * lasts, otherwise «В мережі» when the messenger is open and «Не в мережі» when not.
 */
export function effectivePresence(stored: string, until: Date | null, online: boolean, now = new Date()): string {
  const active = until === null || until > now;
  if (MANUAL.has(stored) && active) return stored;
  return online ? 'ONLINE' : 'OFFLINE';
}
