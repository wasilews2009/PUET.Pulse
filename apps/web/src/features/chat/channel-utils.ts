import type { Channel, UserCard } from '../../api/types';
import { pick } from '../../i18n';

export type Section = 'emergency' | 'official' | 'courses' | 'groups' | 'direct';

export function sectionOf(c: Channel): Section {
  if (c.type === 'EMERGENCY') return 'emergency';
  if (c.type === 'DIRECT' || c.type === 'PRIVATE_GROUP') return 'direct';
  if (c.type === 'COURSE') return 'courses';
  if (c.isOfficial || c.type === 'GOVERNANCE' || c.type === 'ANNOUNCEMENT') return 'official';
  return 'groups';
}

export const SECTION_ORDER: Section[] = ['emergency', 'official', 'courses', 'groups', 'direct'];

export function channelName(c: Channel, lang: string, peer: UserCard | null | undefined, hidden: string): string {
  if (c.type === 'DIRECT') return peer ? pick(lang, peer.fullNameUk, peer.fullNameEn) : hidden;
  return pick(lang, c.nameUk, c.nameEn) || hidden;
}

export const isModerator = (c: Channel) => c.role === 'OWNER' || c.role === 'MODERATOR';

/** Mirrors the server rules so the composer is hidden where a post would be refused anyway. */
export function postingState(c: Channel): 'ok' | 'archived' | 'readOnly' | 'threadsOnly' {
  if (c.archived) return 'archived';
  if (c.role === 'READ_ONLY') return 'readOnly';
  if ((c.type === 'ANNOUNCEMENT' || c.type === 'EMERGENCY') && !isModerator(c)) return 'readOnly';
  if (c.threadsRequired && !isModerator(c)) return 'threadsOnly';
  return 'ok';
}

export const encrypted = (c: Pick<Channel, 'e2eeMode'>) => c.e2eeMode !== 'DISABLED';
