import { ArrowSquareOut } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { BotCard } from '../../api/types';
import { Badge } from '../../components/ui';
import { formatDay } from './bot-meta';

/** One structured bot card. Every string is rendered as text; links are https only (checked by the API). */
export function BotCardView({ card, onOpenTicket }: { card: BotCard; onOpenTicket?: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  switch (card.kind) {
    case 'document_request':
      return (
        <div className="flex flex-col gap-1">
          <span className="title-4">{t(`bots.docTypes.${card.type}`, { defaultValue: card.type })}</span>
          <span>
            <Badge tone={card.status === 'READY' ? 'success' : card.status === 'REJECTED' ? 'danger' : 'neutral'}>
              {t(`bots.docStatus.${card.status}`, { defaultValue: card.status })}
            </Badge>
          </span>
          {card.note && <span className="body-6 text-muted">{t('bots.deanery.note', { note: card.note })}</span>}
        </div>
      );
    case 'study_plan':
      return (
        <div className="flex flex-col gap-1">
          <span className="title-4">
            {t('bots.deanery.studyPlan')} · {t('bots.deanery.semester', { code: card.semester })}
          </span>
          <span>
            <Badge tone={card.status === 'APPROVED' ? 'success' : card.status === 'NEEDS_CHANGES' ? 'accent' : 'neutral'}>
              {t(`bots.planStatus.${card.status}`, { defaultValue: card.status })}
            </Badge>
          </span>
          {card.credits !== null && <span className="caption-5 text-muted">{t('bots.deanery.credits', { n: card.credits })}</span>}
          {card.note && <span className="body-6 text-muted">{t('bots.deanery.note', { note: card.note })}</span>}
        </div>
      );
    case 'schedule_change':
      return <ScheduleChangeView change={card} lang={lang} />;
    case 'ticket':
      return (
        <div className="flex flex-col items-start gap-1">
          <span className="caption-4 text-muted">{t(`bots.desk.events.${card.event}`, { defaultValue: card.event })}</span>
          {onOpenTicket ? (
            <button type="button" onClick={() => onOpenTicket(card.ticketId)} className="text-left title-4 text-primary underline-offset-2 hover:underline">
              {t('bots.desk.number', { n: card.number })}: {card.title}
            </button>
          ) : (
            <span className="title-4">
              {t('bots.desk.number', { n: card.number })}: {card.title}
            </span>
          )}
          <Badge>{t(`bots.desk.status.${card.status}`, { defaultValue: card.status })}</Badge>
        </div>
      );
    case 'approval':
      return (
        <div className="flex flex-col items-start gap-1">
          <span className="caption-4 text-muted">
            {card.event === 'registered' ? t('bots.chancellery.registered', { no: card.registrationNo ?? '' }) : t(`bots.chancellery.${card.event}`)}
          </span>
          <span className="title-4">{card.title}</span>
          <Link to={`/files/${card.fileId}`} className="inline-flex items-center gap-1 caption-4 text-primary underline-offset-2 hover:underline">
            {t('bots.chancellery.open')}
            <ArrowSquareOut size={14} aria-hidden="true" />
          </Link>
        </div>
      );
    case 'answer':
      return null;
  }
}

export function ScheduleChangeView({ change: c, lang }: { change: Extract<BotCard, { kind: 'schedule_change' }>; lang: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-1">
      <span>
        <Badge tone={c.change === 'CANCELLED' ? 'danger' : c.change === 'ONLINE' ? 'navy' : 'accent'}>{t(`bots.schedule.kinds.${c.change}`, { defaultValue: c.change })}</Badge>
      </span>
      <span className="title-4">{[c.discipline, c.group].filter(Boolean).join(' · ')}</span>
      <span className="body-6">{t('bots.schedule.when', { date: formatDay(c.date, lang), pair: c.pair })}</span>
      {c.room && <span className="body-6">{t('bots.schedule.room', { room: c.room })}</span>}
      {c.newDate && (
        <span className="body-6">
          {c.newPair ? t('bots.schedule.movedToPair', { date: formatDay(c.newDate, lang), pair: c.newPair }) : t('bots.schedule.movedTo', { date: formatDay(c.newDate, lang) })}
        </span>
      )}
      {c.note && <span className="body-6 text-muted">{c.note}</span>}
      {c.link && /^https:\/\//.test(c.link) && (
        <a href={c.link} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 caption-4 text-primary underline-offset-2 hover:underline">
          {t('bots.schedule.join')}
          <ArrowSquareOut size={14} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}
