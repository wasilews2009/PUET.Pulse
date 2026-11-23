import { useQuery } from '@tanstack/react-query';
import type { Message } from '../../api/types';
import { getCrypto } from '../../e2ee/crypto';
import { useMe } from '../../session/session';

export interface Plain {
  text: string | null;
  encrypted: boolean;
  failed: boolean;
  verified: boolean;
  /** The decrypted event content of E2EE messages (attachments, polls). */
  content?: Record<string, unknown>;
}

/** Query options shared by message bubbles and E2EE poll tallies (same cache entry). */
export function decryptOptions(m: Message, userId: string) {
  return {
    queryKey: ['plain', m.id, m.editedAt ?? ''] as const,
    enabled: !m.deleted && !!m.ciphertext,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: 1,
    queryFn: async (): Promise<Plain> => {
      const crypto = await getCrypto(userId);
      const d = await crypto.decrypt({ id: m.id, channelId: m.channelId, senderId: m.senderId, createdAt: m.createdAt, ciphertext: m.ciphertext! });
      const body = typeof d.content.body === 'string' ? d.content.body : '';
      return { text: body, encrypted: true, failed: false, verified: d.verified, content: d.content };
    },
  };
}

/**
 * Plaintext of a message. Unencrypted channels carry `body`; E2EE channels are
 * decrypted locally by vodozemac. Plaintext stays in memory only (React Query
 * cache), never in localStorage or logs.
 */
export function useDecrypted(m: Message): Plain {
  const me = useMe();
  const q = useQuery(decryptOptions(m, me.userId));
  if (m.deleted) return { text: null, encrypted: false, failed: false, verified: true };
  if (!m.ciphertext) return { text: m.body, encrypted: false, failed: false, verified: true };
  if (q.data) return q.data;
  return { text: null, encrypted: true, failed: q.isError, verified: true };
}
