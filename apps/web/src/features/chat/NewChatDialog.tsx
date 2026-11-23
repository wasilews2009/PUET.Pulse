import { Check, MagnifyingGlass } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api, ApiError } from '../../api/client';
import { keys } from '../../api/queries';
import type { UserCard } from '../../api/types';
import { Avatar, Button, cx, Dialog, Field, InlineError, Input, Select, Skeleton, Toggle } from '../../components/ui';
import { pick } from '../../i18n';
import { useMe } from '../../session/session';

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Directory search; results are already filtered by the server (minor protection, guests, tenants). */
export function PeopleSearch({ onPick, selected = [], exclude = [] }: { onPick: (c: UserCard) => void; selected?: string[]; exclude?: string[] }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const res = useQuery({
    queryKey: ['directory', term],
    enabled: term.length >= 2,
    queryFn: async () => {
      const list = await api<UserCard[]>(`/directory?q=${encodeURIComponent(term)}`);
      for (const c of list) qc.setQueryData(keys.card(c.id), c);
      return list;
    },
  });
  const list = (res.data ?? []).filter((c) => !exclude.includes(c.id));
  return (
    <div className="flex flex-col gap-3">
      <label className="relative block">
        <span className="sr-only">{t('newChat.search')}</span>
        <MagnifyingGlass size={18} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
        <Input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('newChat.search')} className="pl-9" />
      </label>
      {term.length < 2 && <p className="caption-5 text-muted">{t('newChat.min')}</p>}
      {res.isFetching && (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      )}
      {res.isError && <InlineError>{t('app.error')}</InlineError>}
      {res.data && list.length === 0 && <p className="body-6 text-muted">{t('newChat.none')}</p>}
      <ul className="flex flex-col gap-1">
        {list.map((c) => {
          const name = pick(i18n.language, c.fullNameUk, c.fullNameEn);
          const on = selected.includes(c.id);
          return (
            <li key={c.id}>
              <button
                type="button"
                aria-pressed={selected.length ? on : undefined}
                onClick={() => onPick(c)}
                className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-300 ease-pulse hover:bg-surface-hover', on && 'bg-surface-hover')}
              >
                <Avatar id={c.id} name={name} presence={c.presence} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate body-5">{name}</span>
                  <span className="truncate caption-5 text-muted">{[c.academicDegree, c.position].filter(Boolean).join(', ') || t(`presence.${c.presence}`)}</span>
                </span>
                {on && <Check size={18} className="text-primary" />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function NewChatDialog({ mode, onClose }: { mode: 'dm' | 'group' | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const [name, setName] = useState('');
  const [members, setMembers] = useState<UserCard[]>([]);
  const [isEncrypted, setEncrypted] = useState(true);
  const [ttl, setTtl] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mode) {
      setName('');
      setMembers([]);
      setEncrypted(true);
      setTtl('');
      setError(null);
    }
  }, [mode]);

  const done = (channelId: string) => {
    void qc.invalidateQueries({ queryKey: keys.channels });
    onClose();
    navigate(`/chats/${channelId}`);
  };

  const dm = useMutation({
    mutationFn: (userId: string) => api<{ channelId: string }>(`/users/${userId}/direct`, { method: 'POST' }),
    onSuccess: (r) => done(r.channelId),
    onError: (e) => setError(e instanceof ApiError && e.status === 403 ? t('newChat.denied') : t('app.error')),
  });
  const group = useMutation({
    mutationFn: () =>
      api<{ channelId: string }>('/channels', {
        method: 'POST',
        body: { nameUk: name.trim(), memberIds: members.map((m) => m.id), encrypted: isEncrypted, ...(ttl ? { messageTtlSeconds: Number(ttl) } : {}) },
      }),
    onSuccess: (r) => done(r.channelId),
    onError: () => setError(t('app.error')),
  });

  if (mode === 'dm') {
    return (
      <Dialog open onClose={onClose} title={t('newChat.title')}>
        <div className="flex flex-col gap-3">
          {error && <InlineError>{error}</InlineError>}
          <PeopleSearch exclude={[me.userId]} onPick={(c) => dm.mutate(c.id)} />
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog
      open={mode === 'group'}
      onClose={onClose}
      title={t('newChat.groupTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button variant="accent" disabled={!name.trim()} loading={group.isPending} onClick={() => group.mutate()}>
            {t('newChat.create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <InlineError>{error}</InlineError>}
        <Field label={t('newChat.groupName')}>{(id) => <Input id={id} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}</Field>
        <div className="flex flex-wrap items-center gap-6">
          <Toggle checked={isEncrypted} onChange={setEncrypted} label={t('newChat.encrypted')} />
          <Field label={t('newChat.ttl')}>
            {(id) => (
              <Select id={id} value={ttl} onChange={(e) => setTtl(e.target.value)} disabled={!isEncrypted}>
                <option value="">{t('newChat.ttlNone')}</option>
                {(['3600', '86400', '604800'] as const).map((v) => (
                  <option key={v} value={v}>
                    {t(`channel.ttlOptions.${v}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="flex flex-col gap-2">
          <p className="title-4">{t('newChat.groupMembers')}</p>
          {members.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {members.map((m) => (
                <li key={m.id} className="rounded-full bg-surface-hover px-3 py-1 caption-4">
                  {pick(i18n.language, m.fullNameUk, m.fullNameEn)}
                </li>
              ))}
            </ul>
          )}
          <PeopleSearch
            exclude={[me.userId]}
            selected={members.map((m) => m.id)}
            onPick={(c) => setMembers((list) => (list.some((x) => x.id === c.id) ? list.filter((x) => x.id !== c.id) : [...list, c]))}
          />
        </div>
      </div>
    </Dialog>
  );
}
