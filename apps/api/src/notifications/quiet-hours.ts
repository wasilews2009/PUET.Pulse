/**
 * Quiet Hours («Тихі години») and Do Not Disturb. Pure functions, no I/O.
 *
 * A message is always stored and visible in the channel at once. These rules
 * decide only whether the recipient is *notified* now, later (morning digest)
 * or not at all. Priority alerts (Civil Protection) bypass all of them.
 */

export interface QuietHoursRule {
  enabled: boolean;
  /** IANA time zone, e.g. Europe/Kyiv. */
  timezone: string;
  /** Minutes from local midnight, 0..1439. */
  startMinute: number;
  endMinute: number;
  /** ISO weekdays (1 = Monday) on which a window *starts*. */
  weekdays: number[];
  /** Defer into a digest at the end of the window instead of dropping the notification. */
  digestEnabled: boolean;
}

export interface RecipientState {
  presence: string;
  presenceUntil?: Date | null;
  /** Channel muted by the recipient. */
  mutedUntil?: Date | null;
  quietHours?: QuietHoursRule | null;
}

export type NotificationDecision =
  | { action: 'deliver'; silent: boolean }
  | { action: 'defer'; until: Date }
  | { action: 'suppress'; reason: 'muted' | 'dnd' | 'quiet_hours' };

const DAY = 1440;
const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Local minute of day and ISO weekday of an instant in a time zone. */
export function localTime(at: Date, timeZone: string): { minute: number; weekday: number } {
  const parts = formatter(timeZone).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const minute = Number(get('hour')) * 60 + Number(get('minute'));
  return { minute, weekday: WEEKDAY[get('weekday')] ?? 1 };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

const prevWeekday = (d: number) => (d === 1 ? 7 : d - 1);

/**
 * End of the quiet window that contains `now`, or null when `now` is outside it.
 * Windows may cross midnight (18:00 → 08:30); a window belongs to the weekday it starts on.
 */
export function quietHoursEnd(rule: QuietHoursRule, now: Date): Date | null {
  if (!rule.enabled || rule.startMinute === rule.endMinute) return null;
  const { minute, weekday } = localTime(now, rule.timezone);
  const { startMinute: start, endMinute: end } = rule;

  let inside: boolean;
  if (start < end) {
    inside = rule.weekdays.includes(weekday) && minute >= start && minute < end;
  } else {
    inside =
      (minute >= start && rule.weekdays.includes(weekday)) ||
      (minute < end && rule.weekdays.includes(prevWeekday(weekday)));
  }
  if (!inside) return null;

  const delta = (end - minute + DAY) % DAY || DAY;
  const base = new Date(now.getTime() - (now.getTime() % 60_000));
  let release = new Date(base.getTime() + delta * 60_000);
  // A DST change inside the window shifts local time by up to an hour: correct once.
  const drift = localTime(release, rule.timezone).minute - end;
  const fix = drift > DAY / 2 ? drift - DAY : drift < -DAY / 2 ? drift + DAY : drift;
  if (fix !== 0) release = new Date(release.getTime() - fix * 60_000);
  return release;
}

export function decideNotification(
  recipient: RecipientState,
  message: { isPriority: boolean },
  now: Date,
): NotificationDecision {
  // Civil Protection alerts bypass mute, Do Not Disturb and Quiet Hours.
  if (message.isPriority) return { action: 'deliver', silent: false };

  if (recipient.mutedUntil && recipient.mutedUntil > now) return { action: 'suppress', reason: 'muted' };

  const statusActive = !recipient.presenceUntil || recipient.presenceUntil > now;
  if (recipient.presence === 'DO_NOT_DISTURB' && statusActive) {
    return recipient.presenceUntil ? { action: 'defer', until: recipient.presenceUntil } : { action: 'suppress', reason: 'dnd' };
  }

  if (recipient.quietHours) {
    const end = quietHoursEnd(recipient.quietHours, now);
    if (end) {
      return recipient.quietHours.digestEnabled ? { action: 'defer', until: end } : { action: 'suppress', reason: 'quiet_hours' };
    }
  }

  // «На парі», «На засіданні Вченої ради»: delivered without sound.
  const busy = (recipient.presence === 'IN_CLASS' || recipient.presence === 'IN_COUNCIL') && statusActive;
  return { action: 'deliver', silent: busy };
}
