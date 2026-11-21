import type Redis from 'ioredis';

export const DIGEST_STORE = Symbol('DIGEST_STORE');

export interface DueDigest {
  userId: string;
  /** channelId -> number of held notifications. */
  channels: Record<string, number>;
}

/**
 * Deferred notifications (Quiet Hours / timed Do Not Disturb). Holds only ids and
 * counters, never message content. One release time per user: the earliest wins.
 */
export interface DigestStore {
  hold(userId: string, channelId: string, releaseAt: Date): Promise<void>;
  /** Atomically takes every digest whose release time has passed. */
  takeDue(now: Date, limit?: number): Promise<DueDigest[]>;
  /** Leader lock so that one API instance runs the background jobs. */
  acquireLock(name: string, ttlMs: number, owner: string): Promise<boolean>;
}

const DUE_KEY = 'puet:digest:due';
const digestKey = (userId: string) => `puet:digest:u:${userId}`;

/** Pops due user ids and their counters in one atomic step. */
const TAKE_DUE = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
local out = {}
for _, id in ipairs(ids) do
  redis.call('ZREM', KEYS[1], id)
  local k = ARGV[3] .. id
  local h = redis.call('HGETALL', k)
  redis.call('DEL', k)
  table.insert(out, id)
  table.insert(out, h)
end
return out
`;

export class RedisDigestStore implements DigestStore {
  constructor(private readonly redis: Redis) {}

  async hold(userId: string, channelId: string, releaseAt: Date) {
    await this.redis
      .multi()
      .hincrby(digestKey(userId), channelId, 1)
      .expire(digestKey(userId), 8 * 86_400)
      // LT: only move the release earlier; NX semantics when absent.
      .zadd(DUE_KEY, 'LT', releaseAt.getTime(), userId)
      .exec();
  }

  async takeDue(now: Date, limit = 500): Promise<DueDigest[]> {
    const raw = (await this.redis.eval(TAKE_DUE, 1, DUE_KEY, String(now.getTime()), String(limit), 'puet:digest:u:')) as (
      | string
      | string[]
    )[];
    const out: DueDigest[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      const flat = raw[i + 1] as string[];
      const channels: Record<string, number> = {};
      for (let j = 0; j < flat.length; j += 2) channels[flat[j]!] = Number(flat[j + 1]);
      out.push({ userId: raw[i] as string, channels });
    }
    return out;
  }

  async acquireLock(name: string, ttlMs: number, owner: string) {
    const key = `puet:lock:${name}`;
    const ok = await this.redis.set(key, owner, 'PX', ttlMs, 'NX');
    if (ok === 'OK') return true;
    // Renew if we already hold it.
    if ((await this.redis.get(key)) === owner) {
      await this.redis.pexpire(key, ttlMs);
      return true;
    }
    return false;
  }
}

export class MemoryDigestStore implements DigestStore {
  private readonly due = new Map<string, number>();
  private readonly counts = new Map<string, Record<string, number>>();

  async hold(userId: string, channelId: string, releaseAt: Date) {
    const c = this.counts.get(userId) ?? {};
    c[channelId] = (c[channelId] ?? 0) + 1;
    this.counts.set(userId, c);
    const prev = this.due.get(userId);
    if (prev === undefined || releaseAt.getTime() < prev) this.due.set(userId, releaseAt.getTime());
  }

  async takeDue(now: Date, limit = 500) {
    const out: DueDigest[] = [];
    for (const [userId, at] of this.due) {
      if (out.length >= limit) break;
      if (at > now.getTime()) continue;
      this.due.delete(userId);
      out.push({ userId, channels: this.counts.get(userId) ?? {} });
      this.counts.delete(userId);
    }
    return out;
  }

  async acquireLock() {
    return true;
  }
}
