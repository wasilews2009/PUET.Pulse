import type Redis from 'ioredis';

/** Fixed-window counter: `hit` returns false once `limit` hits were made in the window. */
export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<boolean>;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, limit: number, windowMs: number) {
    const k = `rate:${key}`;
    // Create the window with its expiry first, so a crash can never leave a counter without TTL.
    await this.redis.set(k, '0', 'PX', windowMs, 'NX');
    const n = await this.redis.incr(k);
    return n <= limit;
  }
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { n: number; until: number }>();

  async hit(key: string, limit: number, windowMs: number) {
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || w.until <= now) {
      this.windows.set(key, { n: 1, until: now + windowMs });
      return 1 <= limit;
    }
    w.n++;
    return w.n <= limit;
  }
}
