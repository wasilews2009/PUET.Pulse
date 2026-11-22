import { Checks, SealCheck } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { keys, useCard } from '../../api/queries';
import type { AckStats, Channel, Message } from '../../api/types';
import { Avatar, Button, Dialog, InlineError, Skeleton, formatDateTime } from '../../components/ui';
import { pick } from '../../i18n';
import { isModerator } from './channel-utils';

function Person({ id, at }: { id: string; at?: string }) {
  const { t, i18n } = useTranslation();
  const card = useCard(id);
  const name = card.data ? pick(i18n.language, card.data.fullNameUk, card.data.fullNameEn) : t('chats.hiddenUser');
  return (
    <li className="flex items-center gap-3 py-2">
      <Avatar size="sm" id={id} name={name} />
      <span className="min-w-0 flex-1 truncate body-6">{name}</span>
      {at && <span className="caption-5 text-muted">{formatDateTime(at, i18n.language)}</span>}
    </li>
  );
}

function StatsDialog({ messageId, open, onClose }: { messageId: string; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: keys.acks(messageId), queryFn: () => api<AckStats>(`/messages/${messageId}/acks`), enabled: open });
  return (
    <Dialog open={open} onClose={onClose} title={t('directive.statsTitle')}>
      {q.isPending && <Skeleton className="h-32" />}
      {q.isError && <InlineError>{t('app.error')}</InlineError>}
      {q.data && (
        <div className="flex flex-col gap-4">
          <p className="body-5">{t('directive.stats', { n: q.data.acknowledged.length, total: q.data.total })}</p>
          <section>
            <h3 className="title-4">{t('directive.pending')}</h3>
            {q.data.pending.length ? (
              <ul className="divide-y divide-line">
                {q.data.pending.map((id) => (
                  <Person key={id} id={id} />
                ))}
              </ul>
            ) : (
              <p className="caption-5 text-muted">{t('directive.none')}</p>
            )}
          </section>
          <section>
            <h3 className="title-4">{t('directive.done')}</h3>
            {q.data.acknowledged.length ? (
              <ul className="divide-y divide-line">
                {q.data.acknowledged.map((a) => (
                  <Person key={a.userId} id={a.userId} at={a.at} />
                ))}
              </ul>
            ) : (
              <p className="caption-5 text-muted">{t('directive.none')}</p>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}

/** Under a directive: «Ознайомлений» for members, the confirmation list for its author and moderators. */
export function DirectiveBar({ m, channel, mine }: { m: Message; channel: Channel; mine: boolean }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [statsOpen, setStatsOpen] = useState(false);
  const [ackedAt, setAckedAt] = useState<string | null>(m.acknowledgedAt ?? null);
  const ack = useMutation({
    mutationFn: () => api<{ acknowledgedAt: string }>(`/messages/${m.id}/ack`, { method: 'POST' }),
    onSuccess: (r) => {
      setAckedAt(r.acknowledgedAt);
      qc.setQueriesData<{ pages: Message[][] }>({ queryKey: keys.messages(m.channelId, null) }, (data) =>
        data ? { ...data, pages: data.pages.map((p) => p.map((x) => (x.id === m.id ? { ...x, acknowledgedAt: r.acknowledgedAt } : x))) } : data,
      );
    },
  });
  const done = ackedAt ?? m.acknowledgedAt ?? null;
  const canSeeStats = mine || isModerator(channel);

  return (
    <div className="flex flex-wrap items-center gap-2 px-1">
      {!mine &&
        (done ? (
          <span className="flex items-center gap-1 caption-4 text-success">
            <SealCheck size={16} weight="fill" aria-hidden="true" />
            {t('directive.acked', { time: formatDateTime(done, i18n.language) })}
          </span>
        ) : (
          <Button size="sm" variant="accent" icon={<Checks size={16} aria-hidden="true" />} loading={ack.isPending} onClick={() => ack.mutate()}>
            {t('directive.ack')}
          </Button>
        ))}
      {canSeeStats && (
        <button type="button" className="caption-3 text-primary hover:underline" onClick={() => setStatsOpen(true)}>
          {t('directive.statsTitle')}
        </button>
      )}
      {ack.isError && <InlineError>{t('directive.failed')}</InlineError>}
      {canSeeStats && <StatsDialog messageId={m.id} open={statsOpen} onClose={() => setStatsOpen(false)} />}
    </div>
  );
}
