import type { Channel, Me, Slot } from '../../api/types';
import { isModerator } from '../chat/channel-utils';

/** Channel types where only moderators start a call (mirrors the policy engine). */
const MODERATED_CALL_TYPES: readonly string[] = ['ANNOUNCEMENT', 'EMERGENCY', 'GOVERNANCE', 'COURSE'];

/** Hides the call button where the server would refuse anyway. The server decides. */
export function canStartCall(c: Channel): boolean {
  if (c.archived || c.role === 'READ_ONLY') return false;
  // Media goes through the on-premise SFU: rooms with mandatory E2EE get no calls yet.
  if (c.e2eeMode === 'MANDATORY') return false;
  return !MODERATED_CALL_TYPES.includes(c.type) || isModerator(c);
}

/** Same window as the API: from 10 minutes before the slot until 15 minutes after it. */
export const ROOM_EARLY_MS = 10 * 60_000;
export const ROOM_GRACE_MS = 15 * 60_000;

export function roomOpen(slot: Pick<Slot, 'startsAt' | 'endsAt' | 'status' | 'mode'>, now = Date.now()): boolean {
  if (slot.status !== 'ACTIVE' || slot.mode !== 'ONLINE') return false;
  return now >= new Date(slot.startsAt).getTime() - ROOM_EARLY_MS && now <= new Date(slot.endsAt).getTime() + ROOM_GRACE_MS;
}

const HOST_ROLES: readonly string[] = ['LECTURER', 'DEPARTMENT_HEAD', 'INSTITUTE_DIRECTOR'];

/** Teaching staff publish consultation slots. */
export const canHostConsultations = (me: Me) => me.kind === 'STAFF' && me.roles.some((r) => HOST_ROLES.includes(r.role));

export function formatDuration(ms: number, lang: string): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return lang === 'en' ? `${minutes} min` : `${minutes} хв`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return lang === 'en' ? `${h} h${m ? ` ${m} min` : ''}` : `${h} год${m ? ` ${m} хв` : ''}`;
}
