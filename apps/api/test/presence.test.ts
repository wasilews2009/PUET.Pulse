import { describe, expect, it } from 'vitest';
import { effectivePresence, LEASE_MS, MemoryPresenceTracker, RedisPresenceTracker } from '../src/realtime/presence.tracker';

describe('presence', () => {
  const now = new Date('2026-11-24T10:00:00Z');

  it('shows «В мережі» while the messenger is open, «Не в мережі» otherwise', () => {
    // The stored default is OFFLINE: an open socket must still show the person online.
    expect(effectivePresence('OFFLINE', null, true, now)).toBe('ONLINE');
    expect(effectivePresence('ONLINE', null, false, now)).toBe('OFFLINE');
  });

  it('keeps a hand-set status until it expires', () => {
    expect(effectivePresence('IN_CLASS', null, false, now)).toBe('IN_CLASS');
    expect(effectivePresence('DO_NOT_DISTURB', new Date('2026-11-24T11:00:00Z'), true, now)).toBe('DO_NOT_DISTURB');
    expect(effectivePresence('DO_NOT_DISTURB', new Date('2026-11-24T09:00:00Z'), true, now)).toBe('ONLINE');
  });

  it('counts open sockets and lets stale leases lapse', async () => {
    let t = 0;
    const tracker = new MemoryPresenceTracker(() => t);
    await tracker.connected('a', 's1');
    await tracker.connected('a', 's2');
    await tracker.disconnected('a', 's1');
    expect(await tracker.onlineOf(['a', 'b'])).toEqual(new Set(['a']));
    t = LEASE_MS + 1; // the instance holding s2 crashed and never renewed it
    expect(await tracker.onlineOf(['a'])).toEqual(new Set());
  });

  it('fails soft when Redis is unavailable (nobody is shown online)', async () => {
    const tracker = new RedisPresenceTracker({} as never);
    await tracker.connected('a', 's1');
    expect(await tracker.onlineOf(['a'])).toEqual(new Set());
  });
});
