import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { keys, useBotMessages } from '../../api/queries';
import type { BotSlug } from '../../api/types';
import { formatDateTime, InlineError, Skeleton } from '../../components/ui';
import { BotCardView } from './BotCardView';

/** Marks the bot's inbox read while it is open. */
export function useMarkRead(bot: BotSlug, unread: number) {
  const qc = useQueryClient();
  useEffect(() => {
    if (unread === 0) return;
    void api(`/bots/${bot}/read`, { method: 'POST' })
      .then(() => qc.invalidateQueries({ queryKey: keys.bots, exact: true }))
      .catch(() => undefined);
  }, [bot, unread, qc]);
}

/** Recent notifications of one bot, newest first. */
export function BotFeed({ bot, onOpenTicket }: { bot: BotSlug; onOpenTicket?: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const msgs = useBotMessages(bot);
  const cards = (msgs.data ?? []).filter((m) => m.card && m.card.kind !== 'answer').reverse().slice(0, 30);
  return (
    <section aria-labelledby={`feed-${bot}`} className="flex flex-col gap-3">
      <h2 id={`feed-${bot}`} className="heading-6">
        {t('bots.feed')}
      </h2>
      {msgs.isPending && <Skeleton className="h-20" />}
      {msgs.isError && <InlineError>{t('app.error')}</InlineError>}
      {msgs.isSuccess && cards.length === 0 && <p className="body-6 text-muted">{t('bots.feedEmpty')}</p>}
      <ol className="flex flex-col gap-2">
        {cards.map((m) => (
          <li key={m.id} className="flex flex-col gap-2 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
            <time dateTime={m.createdAt} className="caption-5 text-muted">
              {formatDateTime(m.createdAt, i18n.language)}
            </time>
            <BotCardView card={m.card!} {...(onOpenTicket ? { onOpenTicket } : {})} />
          </li>
        ))}
      </ol>
    </section>
  );
}
