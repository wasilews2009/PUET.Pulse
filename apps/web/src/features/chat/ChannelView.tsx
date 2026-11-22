import { ArrowLeft, Bell, BellSlash, Files, Info, Lock, Timer, UsersThree, VideoCamera, X } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { api, isUuid } from '../../api/client';
import { keys, useCard, useMembers, useMessages } from '../../api/queries';
import type { Call, Channel } from '../../api/types';
import { Avatar, Badge, cx, Dialog, IconButton } from '../../components/ui';
import { pick } from '../../i18n';
import { useCallOptions } from '../calls/CallCard';
import { useCalls } from '../calls/CallContext';
import { canStartCall } from '../calls/call-utils';
import { FileList } from '../files/FileList';
import { useTyping } from '../shell/typing';
import { channelName, encrypted, postingState } from './channel-utils';
import { Composer } from './Composer';
import { Bubble, MessageList } from './MessageList';

function Note({ children, tone = 'neutral' }: { children: string; tone?: 'neutral' | 'navy' }) {
  return (
    <p className={cx('flex items-center gap-2 px-4 py-2 caption-4', tone === 'navy' ? 'bg-navy text-white' : 'bg-surface-2 text-muted')}>
      <Info size={16} aria-hidden="true" className="shrink-0" />
      {children}
    </p>
  );
}

function Typing({ channelId }: { channelId: string }) {
  const { t, i18n } = useTranslation();
  const users = useTyping(channelId);
  const first = useCard(users[0]);
  if (!users.length) return null;
  return (
    <p className="px-4 pb-1 caption-5 text-muted" aria-live="polite">
      {t('channel.typing', { name: first.data ? pick(i18n.language, first.data.fullNameUk, first.data.fullNameEn) : '…' })}
    </p>
  );
}

function MemberRow({ userId, role }: { userId: string; role: string }) {
  const { t, i18n } = useTranslation();
  const card = useCard(userId);
  const name = card.data ? pick(i18n.language, card.data.fullNameUk, card.data.fullNameEn) : t('chats.hiddenUser');
  return (
    <li className="flex items-center gap-3 py-2">
      <Avatar id={userId} name={name} presence={card.data?.presence} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate body-5">{name}</span>
        <span className="truncate caption-5 text-muted">{card.data ? [card.data.position, t(`presence.${card.data.presence}`)].filter(Boolean).join(' · ') : ''}</span>
      </span>
      {role !== 'MEMBER' && <Badge tone={role === 'OWNER' ? 'navy' : 'neutral'}>{role}</Badge>}
    </li>
  );
}

function ThreadPanel({ channel, rootId, onClose }: { channel: Channel; rootId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const top = useMessages(channel.id, null);
  const root = top.data?.pages.flat().find((m) => m.id === rootId);
  const state = postingState(channel);
  return (
    <aside aria-label={t('thread.title')} className="absolute inset-0 z-20 flex min-h-0 flex-col border-line bg-canvas lg:static lg:w-96 lg:border-l">
      <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-2">
        <h2 className="heading-6">{t('thread.title')}</h2>
        <IconButton label={t('thread.close')} onClick={onClose}>
          <X size={20} />
        </IconButton>
      </header>
      {root && (
        <ol className="border-b border-line px-4 py-3">
          <Bubble m={root} channel={channel} showAuthor />
        </ol>
      )}
      <MessageList channel={channel} threadRootId={rootId} />
      {state !== 'archived' && state !== 'readOnly' && <Composer channel={channel} threadRootId={rootId} />}
    </aside>
  );
}

export function ChannelView({ channel }: { channel: Channel }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'files' ? 'files' : 'messages';
  const threadParam = params.get('thread');
  const thread = isUuid(threadParam ?? undefined) ? threadParam : null;
  const [membersOpen, setMembersOpen] = useState(false);
  const peer = useCard(channel.type === 'DIRECT' ? channel.peerId : null);
  const members = useMembers(channel.id);
  const name = channelName(channel, i18n.language, peer.data, t('chats.hiddenUser'));
  const state = postingState(channel);
  const lastRead = useRef<string | null>(null);

  const setParam = (k: string, v: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v === null) n.delete(k);
        else n.set(k, v);
        return n;
      },
      { replace: true },
    );

  const markRead = useCallback(
    (messageId: string) => {
      if (lastRead.current === messageId || document.visibilityState !== 'visible') return;
      lastRead.current = messageId;
      void api(`/channels/${channel.id}/read`, { method: 'POST', body: { messageId } }).catch(() => undefined);
      qc.setQueryData<Channel[]>(keys.channels, (list) => list?.map((c) => (c.id === channel.id ? { ...c, unread: 0 } : c)));
    },
    [channel.id, qc],
  );

  const calls = useCalls();
  const callOptions = useCallOptions(channel, null);
  const startCall = useMutation({
    mutationFn: async () => {
      const call = await api<Call>(`/channels/${channel.id}/calls`, { method: 'POST' });
      // The starter may always end their own call.
      await calls.join({ kind: 'call', callId: call.id }, { ...callOptions, canEnd: true });
    },
  });

  const mute = useMutation({
    mutationFn: (mutedUntil: string | null) => api(`/channels/${channel.id}/mute`, { method: 'PUT', body: { mutedUntil } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.channels }),
  });
  const muted = !!channel.mutedUntil;

  return (
    <div className="relative flex min-h-0 flex-1">
      <section aria-label={name} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-line bg-surface px-2 py-2 md:px-4">
          <Link to="/chats" aria-label={t('app.back')} className="flex size-10 items-center justify-center rounded-lg text-muted hover:bg-surface-hover md:hidden">
            <ArrowLeft size={22} />
          </Link>
          {channel.type === 'DIRECT' && <Avatar id={channel.peerId ?? channel.id} name={name} presence={peer.data?.presence} />}
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 className="flex items-center gap-2 truncate heading-6">
              <span className="truncate">{name}</span>
              {channel.isOfficial && (
                <Badge tone="navy" className="hidden sm:inline-flex">
                  {t('channel.official')}
                </Badge>
              )}
            </h2>
            <p className="flex items-center gap-2 truncate caption-5 text-muted">
              {channel.type === 'DIRECT' && peer.data ? t(`presence.${peer.data.presence}`) : t(`channelTypes.${channel.type}`)}
              {encrypted(channel) && (
                <span className="inline-flex items-center gap-1">
                  <Lock size={12} aria-hidden="true" />
                  {t('channel.e2ee')}
                </span>
              )}
              {channel.messageTtlSeconds && (
                <span className="inline-flex items-center gap-1">
                  <Timer size={12} aria-hidden="true" />
                  {t('channel.ttl', { ttl: t(`channel.ttlOptions.${channel.messageTtlSeconds}`) })}
                </span>
              )}
            </p>
          </div>
          <div role="tablist" aria-label={name} className="hidden rounded-lg bg-surface-hover p-0.5 sm:flex">
            {(['messages', 'files'] as const).map((k) => (
              <button
                key={k}
                role="tab"
                type="button"
                aria-selected={tab === k}
                onClick={() => setParam('tab', k === 'files' ? 'files' : null)}
                className={cx('rounded-md px-3 py-1 button-sm transition-colors duration-300 ease-pulse', tab === k ? 'bg-surface text-ink shadow-sm' : 'text-muted')}
              >
                {t(`channel.${k}`)}
              </button>
            ))}
          </div>
          <IconButton className="sm:hidden" label={t('channel.files')} onClick={() => setParam('tab', tab === 'files' ? null : 'files')}>
            <Files size={22} />
          </IconButton>
          {canStartCall(channel) && (
            <IconButton label={t('call.start')} disabled={startCall.isPending || !!calls.active} onClick={() => startCall.mutate()}>
              <VideoCamera size={22} />
            </IconButton>
          )}
          <IconButton label={`${t('channel.members')} (${members.data?.length ?? '…'})`} onClick={() => setMembersOpen(true)}>
            <UsersThree size={22} />
          </IconButton>
          <IconButton label={muted ? t('channel.unmute') : t('channel.mute')} onClick={() => mute.mutate(muted ? null : new Date(Date.now() + 365 * 86_400_000).toISOString())}>
            {muted ? <BellSlash size={22} /> : <Bell size={22} />}
          </IconButton>
        </header>

        {channel.e2eeMode === 'MANDATORY' && <Note tone="navy">{t('channel.e2eeMandatory')}</Note>}
        {startCall.isError && <Note>{t('call.startFailed')}</Note>}
        {state === 'archived' && <Note>{t('channel.archivedNote')}</Note>}
        {state === 'readOnly' && <Note>{t('channel.readOnly')}</Note>}
        {state === 'threadsOnly' && <Note>{t('channel.threadsOnly')}</Note>}

        {tab === 'files' ? (
          <FileList channel={channel} />
        ) : (
          <>
            <MessageList channel={channel} onOpenThread={(id) => setParam('thread', id)} onSeen={markRead} />
            <Typing channelId={channel.id} />
            {state === 'ok' && <Composer channel={channel} onUploaded={() => setParam('tab', 'files')} />}
          </>
        )}
      </section>

      {thread && tab === 'messages' && <ThreadPanel channel={channel} rootId={thread} onClose={() => setParam('thread', null)} />}

      <Dialog open={membersOpen} onClose={() => setMembersOpen(false)} title={`${t('channel.members')} · ${members.data?.length ?? ''}`}>
        <ul className="divide-y divide-line">
          {(members.data ?? []).map((m) => (
            <MemberRow key={m.userId} userId={m.userId} role={m.role} />
          ))}
        </ul>
      </Dialog>
    </div>
  );
}
