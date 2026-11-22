import { useQuery } from '@tanstack/react-query';
import type { Message } from '../../api/types';
import { getCrypto } from '../../e2ee/crypto';
import { useMe } from '../../session/session';

export interface Plain {
  text: string | null;
  encrypted: boolean;
  failed: boolean;
  verified: boolean;
}

/**
 * Plaintext of a message. Unencrypted channels carry `body`; E2EE channels are
 * decrypted locally by vodozemac. Plaintext stays in memory only (React Query
 * cache), never in localStorage or logs.
 */
export function useDecrypted(m: Message): Plain {
  const me = useMe();
  const q = useQuery({
    queryKey: ['plain', m.id, m.editedAt ?? ''],
    enabled: !m.deleted && !!m.ciphertext,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: 1,
    queryFn: async (): Promise<Plain> => {
      const crypto = await getCrypto(me.userId);
      const d = await crypto.decrypt({ id: m.id, channelId: m.channelId, senderId: m.senderId, createdAt: m.createdAt, ciphertext: m.ciphertext! });
      const body = typeof d.content.body === 'string' ? d.content.body : '';
      return { text: body, encrypted: true, failed: false, verified: d.verified };
    },
  });
  if (m.deleted) return { text: null, encrypted: false, failed: false, verified: true };
  if (!m.ciphertext) return { text: m.body, encrypted: false, failed: false, verified: true };
  if (q.data) return q.data;
  return { text: null, encrypted: true, failed: q.isError, verified: true };
}
