import { ChatCircleText, Lock, ShieldWarning, Trash, WarningCircle } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { useCard, useMessages } from '../../api/queries';
import type { Channel, Message } from '../../api/types';
import { Avatar, Badge, Button, cx, EmptyState, InlineError, Skeleton, formatTime } from '../../components/ui';
import { pick } from '../../i18n';
import { useMe } from '../../session/session';
import { useDecrypted } from './useDecrypted';

function dayLabel(iso: string, lang: string, t: (k: string) => string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return t('message.today');
  if (d.toDateString() === y.toDateString()) return t('message.yesterday');
  return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'uk-UA', { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function Bubble({ m, channel, onOpenThread, showAuthor }: { m: Message; channel: Channel; onOpenThread?: (id: string) => void; showAuthor: boolean }) {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const mine = m.senderId === me.userId;
  const sender = useCard(mine ? null : m.senderId);
  const plain = useDecrypted(m);
  const name = mine ? '' : sender.data ? pick(i18n.language, sender.data.fullNameUk, sender.data.fullNameEn) : t('chats.hiddenUser');
  const remove = useMutation({ mutationFn: () => api(`/messages/${m.id}`, { method: 'DELETE' }) });

  return (
    <li className={cx('group flex gap-2', mine ? 'flex-row-reverse' : 'flex-row')}>
      {!mine && <span className="w-8 shrink-0">{showAuthor && <Avatar size="sm" id={m.senderId} name={name} />}</span>}
      <div className={cx('flex max-w-[min(36rem,80%)] flex-col gap-1', mine ? 'items-end' : 'items-start')}>
        {showAuthor && !mine && channel.type !== 'DIRECT' && <span className="px-1 caption-4 text-muted">{name}</span>}
        <div
          className={cx(
            'rounded-2xl px-3 py-2 body-6 shadow-sm',
            mine ? 'rounded-br-md bg-bubble-out text-on-bubble-out' : 'rounded-bl-md bg-bubble-in text-ink ring-1 ring-line',
            m.isPriority && 'ring-2 ring-accent',
            m.deleted && 'opacity-70',
          )}
        >
          {m.isPriority && !m.deleted && (
            <Badge tone="accent" className="mb-1">
              {t('message.priority')}
            </Badge>
          )}
          {m.deleted ? (
            <span className="flex items-center gap-1 text-muted">
              <Trash size={14} aria-hidden="true" />
              {t('message.deleted')}
            </span>
          ) : plain.failed ? (
            <span className="flex items-start gap-1">
              <WarningCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
              {t('message.undecryptable')}
            </span>
          ) : plain.text === null ? (
            <Skeleton className="h-4 w-40" />
          ) : (
            <p className="break-words whitespace-pre-wrap">{plain.text}</p>
          )}
          <span className={cx('mt-1 flex items-center justify-end gap-1 caption-5', mine ? 'text-on-bubble-out/70' : 'text-muted')}>
            {plain.encrypted && <Lock size={12} aria-label={t('message.encrypted')} />}
            {plain.encrypted && !plain.verified && <ShieldWarning size={12} aria-label={t('message.unverifiedDevice')} className="text-accent" />}
            {m.editedAt && !m.deleted && <span>{t('message.edited')}</span>}
            <time dateTime={m.createdAt}>{formatTime(m.createdAt, i18n.language)}</time>
          </span>
        </div>
        <div className="flex items-center gap-2 px-1">
          {onOpenThread && !m.threadRootId && !m.deleted && (
            <button
              type="button"
              onClick={() => onOpenThread(m.id)}
              className={cx(
                'flex items-center gap-1 caption-3 text-primary hover:underline',
                !m.replyCount && !channel.threadsRequired && 'opacity-0 transition-opacity duration-300 ease-pulse group-hover:opacity-100 focus:opacity-100',
              )}
            >
              <ChatCircleText size={14} aria-hidden="true" />
              {m.replyCount ? t('message.replies', { count: m.replyCount }) : t('message.reply')}
            </button>
          )}
          {mine && !m.deleted && !channel.archived && (
            <button
              type="button"
              onClick={() => remove.mutate()}
              className="caption-4 text-muted opacity-0 transition-opacity duration-300 ease-pulse group-hover:opacity-100 focus:opacity-100"
            >
              {t('message.remove')}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/** Timeline, newest at the bottom. History loads backwards in pages of 50. */
export function MessageList({ channel, threadRootId = null, onOpenThread, onSeen }: { channel: Channel; threadRootId?: string | null; onOpenThread?: (id: string) => void; onSeen?: (lastId: string) => void }) {
  const { t, i18n } = useTranslation();
  const q = useMessages(channel.id, threadRootId);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const items = useMemo(() => (q.data?.pages.flat() ?? []).slice().reverse(), [q.data]);
  const newest = items.at(-1)?.id;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items.length, newest]);

  useEffect(() => {
    if (newest && onSeen) onSeen(newest);
  }, [newest, onSeen]);

  if (q.isPending) {
    return (
      <div className="flex flex-1 flex-col justify-end gap-4 p-6" aria-busy="true">
        {['w-60', 'w-40', 'w-72', 'w-52'].map((w, i) => (
          <Skeleton key={w} className={cx('h-12 rounded-2xl', w, i % 2 ? 'self-end' : 'self-start')} />
        ))}
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="p-6">
        <InlineError>{t('app.error')}</InlineError>
      </div>
    );
  }

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
    >
      {q.hasNextPage && (
        <div className="mb-4 flex justify-center">
          <Button size="sm" variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {t('message.loadOlder')}
          </Button>
        </div>
      )}
      {items.length === 0 && !threadRootId && <EmptyState icon={<ChatCircleText size={28} />} title={t('message.empty')} hint={t('message.emptyHint')} />}
      <ol className="flex flex-col gap-2">
        {items.map((m, i) => {
          const prev = items[i - 1];
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
          const showAuthor = newDay || prev?.senderId !== m.senderId || new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60_000;
          return (
            <Fragment key={m.id}>
              {newDay && (
                <li role="separator" className="my-2 flex items-center gap-3 caption-4 text-muted">
                  <span className="h-px flex-1 bg-line" />
                  {dayLabel(m.createdAt, i18n.language, t)}
                  <span className="h-px flex-1 bg-line" />
                </li>
              )}
              <Bubble m={m} channel={channel} showAuthor={showAuthor} {...(onOpenThread ? { onOpenThread } : {})} />
            </Fragment>
          );
        })}
      </ol>
    </div>
  );
}
