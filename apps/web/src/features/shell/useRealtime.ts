import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { keys, markDeleted, upsertMessage } from '../../api/queries';
import type { Channel, Message } from '../../api/types';
import { getSocket } from '../../realtime/socket';
import { useMe } from '../../session/session';
import { cryptoStarted, getCrypto } from '../../e2ee/crypto';
import { typingStore } from './typing';

/**
 * Bridges server events into the React Query cache. The server addresses every
 * event to this user and re-resolves recipients from current memberships, so
 * the client never subscribes to channels by id.
 */
export function useRealtime() {
  const qc = useQueryClient();
  const me = useMe();
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    const s = getSocket();
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onMessage = (m: Message) => {
      upsertMessage(qc, m);
      if (m.senderId !== me.userId && !m.threadRootId) {
        qc.setQueryData<Channel[]>(keys.channels, (list) => list?.map((c) => (c.id === m.channelId ? { ...c, unread: c.unread + 1 } : c)));
      }
      typingStore.stop(m.channelId, m.senderId);
    };
    const onUpdated = (m: Message) => upsertMessage(qc, m);
    const onDeleted = (e: { id: string; channelId: string }) => markDeleted(qc, e.channelId, e.id);
    const refreshChannels = () => void qc.invalidateQueries({ queryKey: keys.channels });
    const onMembers = (e: { channelId: string }) => void qc.invalidateQueries({ queryKey: keys.members(e.channelId) });
    const onFile = (e: { channelId: string | null; fileId: string }) => {
      if (e.channelId) void qc.invalidateQueries({ queryKey: keys.files(e.channelId) });
      void qc.invalidateQueries({ queryKey: keys.file(e.fileId) });
    };
    const onSigned = (e: { fileId: string }) => {
      void qc.invalidateQueries({ queryKey: keys.signatures(e.fileId) });
      void qc.invalidateQueries({ queryKey: keys.verification(e.fileId) });
    };
    const onApproval = (e: { fileId: string }) => {
      void qc.invalidateQueries({ queryKey: keys.approvals });
      void qc.invalidateQueries({ queryKey: keys.routes(e.fileId) });
    };
    const onPoll = (e: { pollId: string }) => void qc.invalidateQueries({ queryKey: keys.poll(e.pollId) });
    const onAck = (e: { messageId: string }) => void qc.invalidateQueries({ queryKey: keys.acks(e.messageId) });
    const onCall = (e: { callId: string; slotId: string | null }) => {
      void qc.invalidateQueries({ queryKey: keys.call(e.callId) });
      if (e.slotId) void qc.invalidateQueries({ queryKey: keys.consultations });
    };
    const onConsultation = () => void qc.invalidateQueries({ queryKey: keys.consultations });
    const onBot = (e: { bot: string }) => {
      void qc.invalidateQueries({ queryKey: keys.bots, exact: true });
      if (!/^[a-z-]{3,20}$/.test(e.bot)) return;
      void qc.invalidateQueries({ queryKey: ['bots', 'messages', e.bot] });
      if (e.bot === 'deanery') void qc.invalidateQueries({ queryKey: ['bots', 'deanery'] });
      if (e.bot === 'schedule') void qc.invalidateQueries({ queryKey: keys.schedule });
      if (e.bot === 'service-desk') void qc.invalidateQueries({ queryKey: ['bots', 'tickets'] });
    };
    const onTyping = (e: { channelId: string; userId: string }) => typingStore.start(e.channelId, e.userId);
    const onNotification = (e: { channelId: string; silent: boolean; priority: boolean }) => {
      if (e.silent || document.visibilityState === 'visible') return;
      if ('Notification' in window && Notification.permission === 'granted') {
        // Content-free: the notification names neither the sender nor the text.
        new Notification('PUET.Pulse', { body: e.priority ? '❗' : '', tag: e.channelId, icon: '/icon-192.png' });
      }
    };
    const onE2ee = () => {
      if (cryptoStarted(me.userId)) void getCrypto(me.userId).then((c) => c.sync()).catch(() => undefined);
    };

    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.on('connect_error', onDisconnect);
    s.on('message.new', onMessage);
    s.on('message.updated', onUpdated);
    s.on('message.deleted', onDeleted);
    for (const ev of ['channel.joined', 'channel.left', 'channel.updated', 'channel.read']) s.on(ev, refreshChannels);
    s.on('channel.members_changed', onMembers);
    s.on('file.ready', onFile);
    s.on('file.rejected', onFile);
    s.on('file.signed', onSigned);
    s.on('approval.requested', onApproval);
    s.on('approval.updated', onApproval);
    s.on('poll.updated', onPoll);
    s.on('message.ack', onAck);
    s.on('call.updated', onCall);
    s.on('consultation.updated', onConsultation);
    s.on('bot.message', onBot);
    s.on('typing', onTyping);
    s.on('notification', onNotification);
    s.on('e2ee.to_device', onE2ee);
    s.on('e2ee.devices_changed', onE2ee);
    return () => {
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      s.off('connect_error', onDisconnect);
      s.off('message.new', onMessage);
      s.off('poll.updated', onPoll);
      s.off('message.ack', onAck);
      s.off('call.updated', onCall);
      s.off('consultation.updated', onConsultation);
      s.off('message.updated', onUpdated);
      s.off('message.deleted', onDeleted);
      for (const ev of ['channel.joined', 'channel.left', 'channel.updated', 'channel.read']) s.off(ev, refreshChannels);
      s.off('channel.members_changed', onMembers);
      s.off('file.ready', onFile);
      s.off('file.rejected', onFile);
      s.off('file.signed', onSigned);
      s.off('approval.requested', onApproval);
      s.off('approval.updated', onApproval);
      s.off('bot.message', onBot);
      s.off('typing', onTyping);
      s.off('notification', onNotification);
      s.off('e2ee.to_device', onE2ee);
      s.off('e2ee.devices_changed', onE2ee);
    };
  }, [qc, me.userId]);

  return { connected };
}
