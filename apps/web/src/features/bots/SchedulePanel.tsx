import { CalendarCheck } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useScheduleChanges } from '../../api/queries';
import { EmptyState, InlineError, Skeleton } from '../../components/ui';
import { ScheduleChangeView } from './BotCardView';

/** «Розклад ПУЕТ»: upcoming changes for the person's groups and courses. */
export function SchedulePanel() {
  const { t, i18n } = useTranslation();
  const changes = useScheduleChanges();
  return (
    <section aria-labelledby="schedule-upcoming" className="flex flex-col gap-3">
      <h2 id="schedule-upcoming" className="heading-6">
        {t('bots.schedule.upcoming')}
      </h2>
      {changes.isPending && <Skeleton className="h-24" />}
      {changes.isError && <InlineError>{t('app.error')}</InlineError>}
      {changes.data?.length === 0 && <EmptyState icon={<CalendarCheck size={28} />} title={t('bots.schedule.none')} />}
      <ul className="flex flex-col gap-2">
        {changes.data?.map((c) => (
          <li key={c.changeId} className="rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
            <ScheduleChangeView change={c} lang={i18n.language} />
          </li>
        ))}
      </ul>
    </section>
  );
}
