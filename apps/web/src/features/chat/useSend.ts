import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { keys, upsertMessage } from '../../api/queries';
import type { Channel, Member, Message } from '../../api/types';
import { getCrypto } from '../../e2ee/crypto';
import { useMe } from '../../session/session';
import { encrypted } from './channel-utils';

function clientId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Sends a message. Official (DISABLED) channels get plaintext; E2EE channels get
 * a Megolm ciphertext produced on this device for the channel's current members.
 * The client-generated id makes a retry after a network error idempotent.
 */
export function useSend(channel: Channel, threadRootId: string | null) {
  const qc = useQueryClient();
  const me = useMe();
  return useMutation({
    mutationFn: async (text: string): Promise<Message> => {
      const base = { clientMessageId: clientId(), ...(threadRootId ? { threadRootId } : {}) };
      if (!encrypted(channel)) {
        return api<Message>(`/channels/${channel.id}/messages`, { method: 'POST', body: { ...base, body: text } });
      }
      const members = await qc.fetchQuery({ queryKey: keys.members(channel.id), queryFn: () => api<Member[]>(`/channels/${channel.id}/members`), staleTime: 30_000 });
      const crypto = await getCrypto(me.userId);
      const sealed = await crypto.encrypt(
        channel.id,
        members.map((m) => m.userId),
        { msgtype: 'm.text', body: text },
      );
      const deviceId = crypto.machine.deviceId.toString();
      const sent = await api<Message>(`/channels/${channel.id}/messages`, {
        method: 'POST',
        body: { ...base, ciphertext: sealed.ciphertext, scheme: sealed.scheme, senderDeviceId: deviceId },
      });
      // Our own plaintext is known: seed the cache so the message renders without a round trip.
      qc.setQueryData(['plain', sent.id, sent.editedAt ?? ''], { text, encrypted: true, failed: false, verified: true });
      return sent;
    },
    onSuccess: (m) => upsertMessage(qc, m),
  });
}
