import { Check } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { Presence, UserCard } from '../../api/types';
import { Avatar, cx } from '../../components/ui';
import { useMe } from '../../session/session';

export const PRESENCES: Presence[] = ['ONLINE', 'IN_CLASS', 'IN_COUNCIL', 'ON_BUSINESS_TRIP', 'DO_NOT_DISTURB'];

/** «На парі», «Не турбувати» …: the status shown to colleagues and used by notifications. */
export function PresenceMenu({ name, placement = 'right' }: { name: string; placement?: 'right' | 'below' }) {
  const { t } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const self = useQuery({ queryKey: ['card', me.userId], queryFn: () => api<UserCard>(`/users/${me.userId}`), staleTime: 60_000 });
  const set = useMutation({
    mutationFn: (status: Presence) => api<{ status: Presence }>('/me/presence', { method: 'PUT', body: { status } }),
    onSuccess: (r) => qc.setQueryData<UserCard>(['card', me.userId], (c) => (c ? { ...c, presence: r.status } : c)),
  });

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const presence = self.data?.presence ?? 'ONLINE';
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${name}: ${t(`presence.${presence}`)}`}
        title={`${name}: ${t(`presence.${presence}`)}`}
        onClick={() => setOpen((v) => !v)}
        className="rounded-full p-1 transition-transform duration-300 ease-pulse active:scale-[0.98]"
      >
        <Avatar id={me.userId} name={name} presence={presence} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t('presence.set')}
          className={cx(
            'absolute z-40 w-56 rounded-xl border border-line bg-surface p-1 text-ink shadow-xl',
            placement === 'right' ? 'bottom-0 left-full ml-2' : 'top-full right-0 mt-2',
          )}
        >
          <p className="px-3 py-2 caption-3 text-muted">{name}</p>
          {PRESENCES.map((p) => (
            <button
              key={p}
              type="button"
              role="menuitemradio"
              aria-checked={presence === p}
              onClick={() => {
                set.mutate(p);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left body-6 hover:bg-surface-hover"
            >
              {t(`presence.${p}`)}
              {presence === p && <Check size={16} className="text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
