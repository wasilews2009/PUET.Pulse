import { Archive, BellSlash, ChatCircleDots, Lock, MagnifyingGlass, Megaphone, PencilSimpleLine, Siren, UsersThree } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { keys, useCard, useChannels } from '../../api/queries';
import type { Channel, UserCard } from '../../api/types';
import { Avatar, Badge, cx, EmptyState, IconButton, InlineError, Skeleton } from '../../components/ui';
import { channelName, encrypted, SECTION_ORDER, sectionOf } from './channel-utils';
import { NewChatDialog } from './NewChatDialog';

function ChannelIcon({ c, name }: { c: Channel; name: string }) {
  if (c.type === 'DIRECT') return <Avatar id={c.peerId ?? c.id} name={name} />;
  const Icon = c.type === 'EMERGENCY' ? Siren : c.type === 'ANNOUNCEMENT' ? Megaphone : c.type === 'PRIVATE_GROUP' ? ChatCircleDots : UsersThree;
  return (
    <span
      aria-hidden="true"
      className={cx(
        'flex size-10 shrink-0 items-center justify-center rounded-xl',
        c.type === 'EMERGENCY' ? 'bg-accent text-on-accent' : c.isOfficial ? 'bg-navy text-white' : 'bg-surface-hover text-primary',
      )}
    >
      <Icon size={22} weight={c.type === 'EMERGENCY' ? 'fill' : 'regular'} />
    </span>
  );
}

function Row({ c }: { c: Channel }) {
  const { t, i18n } = useTranslation();
  const peer = useCard(c.type === 'DIRECT' ? c.peerId : null);
  const name = channelName(c, i18n.language, peer.data, t('chats.hiddenUser'));
  const muted = !!c.mutedUntil;
  return (
    <li>
      <NavLink
        to={`/chats/${c.id}`}
        className={({ isActive }) =>
          cx(
            'flex items-center gap-3 rounded-xl px-3 py-2 transition-colors duration-300 ease-pulse',
            isActive ? 'bg-primary text-on-primary' : 'hover:bg-surface-hover',
          )
        }
      >
        {({ isActive }) => (
          <>
            <ChannelIcon c={c} name={name} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1">
                <span className={cx('truncate', c.unread && !muted ? 'body-4' : 'body-5')}>{name}</span>
                {encrypted(c) && <Lock size={14} aria-label={t('channel.e2ee')} className="shrink-0 opacity-70" />}
              </span>
              <span className={cx('truncate caption-5', isActive ? 'text-on-primary/80' : 'text-muted')}>
                {c.archived ? t('chats.archived') : t(`channelTypes.${c.type}`)}
              </span>
            </span>
            {muted && <BellSlash size={16} aria-label={t('chats.muted')} className="shrink-0 opacity-60" />}
            {c.archived && <Archive size={16} aria-hidden="true" className="shrink-0 opacity-60" />}
            {c.unread > 0 && (
              <span
                aria-label={t('chats.unread', { count: c.unread })}
                className={cx('min-w-6 rounded-full px-2 text-center caption-3 leading-6', muted ? 'bg-surface-hover text-muted' : 'bg-accent text-on-accent')}
              >
                {c.unread > 99 ? '99+' : c.unread}
              </span>
            )}
          </>
        )}
      </NavLink>
    </li>
  );
}

export function ChannelList() {
  const { t, i18n } = useTranslation();
  const channels = useChannels();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<'dm' | 'group' | null>(null);

  const grouped = useMemo(() => {
    const term = q.trim().toLocaleLowerCase();
    const label = (c: Channel) => {
      if (c.type !== 'DIRECT' || !c.peerId) return `${c.nameUk ?? ''} ${c.nameEn ?? ''}`;
      const card = qc.getQueryData<UserCard | null>(keys.card(c.peerId));
      return card ? `${card.fullNameUk} ${card.fullNameEn ?? ''}` : '';
    };
    const list = (channels.data ?? []).filter((c) => !term || label(c).toLocaleLowerCase().includes(term));
    const by = new Map<string, Channel[]>();
    for (const c of list) by.set(sectionOf(c), [...(by.get(sectionOf(c)) ?? []), c]);
    for (const arr of by.values())
      arr.sort((a, b) => Number(a.archived) - Number(b.archived) || b.unread - a.unread || (a.nameUk ?? '').localeCompare(b.nameUk ?? '', i18n.language));
    return SECTION_ORDER.filter((s) => by.has(s)).map((s) => [s, by.get(s)!] as const);
  }, [channels.data, q, i18n.language, qc]);

  return (
    <aside aria-label={t('chats.title')} className="flex h-full min-h-0 flex-col border-line bg-surface md:w-80 md:border-r">
      <header className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
        <h1 className="heading-5">{t('chats.title')}</h1>
        <div className="flex gap-1">
          <IconButton label={t('chats.newGroup')} onClick={() => setDialog('group')}>
            <UsersThree size={22} />
          </IconButton>
          <IconButton label={t('chats.newChat')} onClick={() => setDialog('dm')}>
            <PencilSimpleLine size={22} />
          </IconButton>
        </div>
      </header>
      <div className="px-4 pb-2">
        <label className="relative block">
          <span className="sr-only">{t('chats.search')}</span>
          <MagnifyingGlass size={18} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('chats.search')}
            className="w-full rounded-lg border border-line bg-surface-2 py-2 pr-3 pl-9 body-6 placeholder:text-muted focus:border-primary focus:outline-none"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {channels.isPending && (
          <ul className="flex flex-col gap-2 px-2 pt-2" aria-busy="true">
            {Array.from({ length: 7 }, (_, i) => (
              <li key={i} className="flex items-center gap-3">
                <Skeleton className="size-10 rounded-xl" />
                <span className="flex flex-1 flex-col gap-1">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </span>
              </li>
            ))}
          </ul>
        )}
        {channels.isError && (
          <div className="p-2">
            <InlineError>{t('app.error')}</InlineError>
          </div>
        )}
        {channels.data?.length === 0 && <EmptyState icon={<ChatCircleDots size={28} />} title={t('chats.empty')} hint={t('chats.emptyHint')} />}
        {grouped.map(([section, list]) => (
          <section key={section} aria-labelledby={`sec-${section}`} className="mt-2">
            <h2 id={`sec-${section}`} className="flex items-center gap-2 px-3 py-1 caption-3 tracking-wide text-muted uppercase">
              {section === 'emergency' && <Badge tone="accent">SOS</Badge>}
              {t(`chats.sections.${section}`)}
            </h2>
            <ul className="flex flex-col gap-0.5">
              {list.map((c) => (
                <Row key={c.id} c={c} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      <NewChatDialog mode={dialog} onClose={() => setDialog(null)} />
    </aside>
  );
}
