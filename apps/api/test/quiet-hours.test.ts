import { describe, expect, it } from 'vitest';
import { MemoryDigestStore } from '../src/notifications/digest.store';
import { decideNotification, localTime, quietHoursEnd, type QuietHoursRule } from '../src/notifications/quiet-hours';

const kyiv: QuietHoursRule = {
  enabled: true,
  timezone: 'Europe/Kyiv',
  startMinute: 18 * 60, // 18:00
  endMinute: 8 * 60 + 30, // 08:30
  weekdays: [1, 2, 3, 4, 5],
  digestEnabled: true,
};

// 2026-11-23 is a Monday. Kyiv is UTC+2 in November.
const at = (iso: string) => new Date(iso);

describe('Quiet Hours («Тихі години»)', () => {
  it('reads local time in the schedule time zone', () => {
    expect(localTime(at('2026-11-23T17:00:00Z'), 'Europe/Kyiv')).toEqual({ minute: 19 * 60, weekday: 1 });
  });

  it('holds notifications in the evening until 08:30 local time next morning', () => {
    expect(quietHoursEnd(kyiv, at('2026-11-23T17:00:00Z'))?.toISOString()).toBe('2026-11-24T06:30:00.000Z');
  });

  it('covers the night after a weekday (window crosses midnight)', () => {
    // Tuesday 03:00 Kyiv belongs to Monday's window.
    expect(quietHoursEnd(kyiv, at('2026-11-24T01:00:00Z'))?.toISOString()).toBe('2026-11-24T06:30:00.000Z');
  });

  it('is off during working hours and on days not in the schedule', () => {
    expect(quietHoursEnd(kyiv, at('2026-11-23T10:00:00Z'))).toBeNull(); // Monday 12:00
    expect(quietHoursEnd(kyiv, at('2026-11-28T17:00:00Z'))).toBeNull(); // Saturday 19:00
    expect(quietHoursEnd({ ...kyiv, enabled: false }, at('2026-11-23T17:00:00Z'))).toBeNull();
  });

  it('handles the DST change inside the window (Kyiv, 2027-03-28)', () => {
    // Friday 2027-03-26 19:00 (UTC+2) → Saturday is outside weekdays, so check a Sunday-night window.
    const everyDay = { ...kyiv, weekdays: [1, 2, 3, 4, 5, 6, 7] };
    const end = quietHoursEnd(everyDay, at('2027-03-27T20:00:00Z'))!; // Sat 22:00 local, DST starts that night
    expect(localTime(end, 'Europe/Kyiv').minute).toBe(8 * 60 + 30);
    expect(end.toISOString()).toBe('2027-03-28T05:30:00.000Z'); // 08:30 at UTC+3
  });
});

describe('notification decisions', () => {
  const now = at('2026-11-23T17:00:00Z');

  it('Civil Protection alerts bypass Quiet Hours, Do Not Disturb and mute', () => {
    const r = decideNotification(
      { presence: 'DO_NOT_DISTURB', mutedUntil: at('2027-01-01T00:00:00Z'), quietHours: kyiv },
      { isPriority: true },
      now,
    );
    expect(r).toEqual({ action: 'deliver', silent: false });
  });

  it('defers student messages to a lecturer into the morning digest', () => {
    expect(decideNotification({ presence: 'ONLINE', quietHours: kyiv }, { isPriority: false }, now)).toEqual({
      action: 'defer',
      until: at('2026-11-24T06:30:00Z'),
    });
    expect(
      decideNotification({ presence: 'ONLINE', quietHours: { ...kyiv, digestEnabled: false } }, { isPriority: false }, now),
    ).toEqual({ action: 'suppress', reason: 'quiet_hours' });
  });

  it('Do Not Disturb with an end time defers; without one it suppresses; expired DND delivers', () => {
    const until = at('2026-11-23T18:00:00Z');
    expect(decideNotification({ presence: 'DO_NOT_DISTURB', presenceUntil: until }, { isPriority: false }, now)).toEqual({
      action: 'defer',
      until,
    });
    expect(decideNotification({ presence: 'DO_NOT_DISTURB' }, { isPriority: false }, now).action).toBe('suppress');
    expect(
      decideNotification({ presence: 'DO_NOT_DISTURB', presenceUntil: at('2026-11-23T16:00:00Z') }, { isPriority: false }, now).action,
    ).toBe('deliver');
  });

  it('«На парі» delivers silently; a muted channel stays silent', () => {
    expect(decideNotification({ presence: 'IN_CLASS' }, { isPriority: false }, now)).toEqual({ action: 'deliver', silent: true });
    expect(decideNotification({ presence: 'ONLINE', mutedUntil: at('2026-11-24T00:00:00Z') }, { isPriority: false }, now)).toEqual({
      action: 'suppress',
      reason: 'muted',
    });
  });
});

describe('digest store', () => {
  it('counts held notifications per channel and releases each user once, at the earliest time', async () => {
    const store = new MemoryDigestStore();
    await store.hold('u1', 'c1', at('2026-11-24T06:30:00Z'));
    await store.hold('u1', 'c1', at('2026-11-24T07:00:00Z'));
    await store.hold('u1', 'c2', at('2026-11-24T06:30:00Z'));
    expect(await store.takeDue(at('2026-11-24T06:00:00Z'))).toEqual([]);
    expect(await store.takeDue(at('2026-11-24T06:31:00Z'))).toEqual([{ userId: 'u1', channels: { c1: 2, c2: 1 } }]);
    expect(await store.takeDue(at('2026-11-24T08:00:00Z'))).toEqual([]);
  });
});
