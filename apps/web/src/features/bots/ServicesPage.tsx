import { ArrowLeft, ShieldCheck, SquaresFour } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { NavLink, useParams } from 'react-router';
import { useBots } from '../../api/queries';
import type { BotSlug } from '../../api/types';
import { cx, EmptyState, InlineError, Skeleton } from '../../components/ui';
import { NotFoundPage } from '../../pages/NotFoundPage';
import { AdmissionsPanel } from './AdmissionsPanel';
import { BotIcon, BOT_ORDER, isBotSlug } from './bot-meta';
import { useMarkRead } from './BotFeed';
import { ChancelleryPanel } from './ChancelleryPanel';
import { DeaneryPanel } from './DeaneryPanel';
import { SchedulePanel } from './SchedulePanel';
import { ServiceDeskPanel } from './ServiceDeskPanel';
import { TrustPanel, useTrustServices } from '../trust/TrustPanel';

function Panel({ bot, unread }: { bot: BotSlug; unread: number }) {
  useMarkRead(bot, unread);
  switch (bot) {
    case 'deanery':
      return <DeaneryPanel />;
    case 'schedule':
      return <SchedulePanel />;
    case 'service-desk':
      return <ServiceDeskPanel />;
    case 'chancellery':
      return <ChancelleryPanel />;
    case 'admissions':
      return <AdmissionsPanel />;
  }
}

/** «Сервіси»: the corporate bots this person may use (decided by the API), each with its own inbox. */
export default function ServicesPage() {
  const { t } = useTranslation();
  const { bot } = useParams();
  const bots = useBots();
  const list = BOT_ORDER.flatMap((slug) => bots.data?.filter((b) => b.bot === slug) ?? []);
  const open = isBotSlug(bot) ? list.find((b) => b.bot === bot) : undefined;
  // Anonymous appeals: shown to staff and students (the API refuses everyone else).
  const trust = useTrustServices();
  const trustOpen = bot === 'trust' && trust.isSuccess;
  const bad = bot !== undefined && !(bot === 'trust' && !trust.isError) && (!isBotSlug(bot) || (bots.isSuccess && !open));

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-labelledby="services-title" className={cx('min-h-0 w-full shrink-0 flex-col gap-4 overflow-y-auto border-line bg-surface p-4 md:flex md:w-80 md:border-r', bot ? 'hidden' : 'flex')}>
        <div>
          <h1 id="services-title" className="heading-5">
            {t('bots.title')}
          </h1>
          <p className="body-6 text-muted">{t('bots.subtitle')}</p>
        </div>
        {bots.isPending && (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        )}
        {bots.isError && <InlineError>{t('app.error')}</InlineError>}
        {bots.isSuccess && list.length === 0 && !trust.isSuccess && <EmptyState icon={<SquaresFour size={28} />} title={t('bots.empty')} hint={t('bots.emptyHint')} />}
        <ul className="flex flex-col gap-1">
          {list.map((b) => (
            <li key={b.bot}>
              <NavLink
                to={`/services/${b.bot}`}
                className={({ isActive }) =>
                  cx('flex items-center gap-3 rounded-xl px-3 py-3 transition-colors duration-300 ease-pulse', isActive ? 'bg-primary text-on-primary' : 'hover:bg-surface-hover')
                }
              >
                {({ isActive }) => (
                  <>
                    <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', isActive ? 'bg-white/15' : 'bg-canvas text-primary')}>
                      <BotIcon bot={b.bot} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate title-4">{t(`bots.names.${b.bot}`)}</span>
                      <span className={cx('truncate caption-5', isActive ? 'text-on-primary/80' : 'text-muted')}>{t(`bots.about.${b.bot}`)}</span>
                    </span>
                    {b.unread > 0 && (
                      <span className="min-w-5 rounded-full bg-accent px-1.5 text-center caption-3 text-on-accent" aria-label={t('bots.unread', { n: b.unread })}>
                        {b.unread > 99 ? '99+' : b.unread}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            </li>
          ))}
          {trust.isSuccess && (
            <li>
              <NavLink
                to="/services/trust"
                className={({ isActive }) =>
                  cx('flex items-center gap-3 rounded-xl px-3 py-3 transition-colors duration-300 ease-pulse', isActive ? 'bg-primary text-on-primary' : 'hover:bg-surface-hover')
                }
              >
                {({ isActive }) => (
                  <>
                    <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', isActive ? 'bg-white/15' : 'bg-canvas text-primary')}>
                      <ShieldCheck size={22} aria-hidden="true" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate title-4">{t('trust.nav')}</span>
                      <span className={cx('truncate caption-5', isActive ? 'text-on-primary/80' : 'text-muted')}>{t('trust.about')}</span>
                    </span>
                  </>
                )}
              </NavLink>
            </li>
          )}
        </ul>
      </aside>
      <main id="main" className={cx('min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-canvas', bot ? 'flex' : 'hidden md:flex')}>
        {bad ? (
          <NotFoundPage />
        ) : trustOpen ? (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
            <header className="flex items-center gap-3">
              <NavLink to="/services" aria-label={t('app.back')} className="inline-flex size-10 items-center justify-center rounded-lg text-muted hover:bg-surface-hover md:hidden">
                <ArrowLeft size={20} aria-hidden="true" />
              </NavLink>
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-on-primary">
                <ShieldCheck size={24} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="heading-5">{t('trust.nav')}</h2>
                <p className="body-6 text-muted">{t('trust.about')}</p>
              </div>
            </header>
            <TrustPanel />
          </div>
        ) : open ? (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
            <header className="flex items-center gap-3">
              <NavLink to="/services" aria-label={t('app.back')} className="inline-flex size-10 items-center justify-center rounded-lg text-muted hover:bg-surface-hover md:hidden">
                <ArrowLeft size={20} aria-hidden="true" />
              </NavLink>
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-on-primary">
                <BotIcon bot={open.bot} size={24} />
              </span>
              <div className="min-w-0">
                <h2 className="heading-5">{t(`bots.names.${open.bot}`)}</h2>
                <p className="body-6 text-muted">{t(`bots.about.${open.bot}`)}</p>
              </div>
            </header>
            <Panel key={open.bot} bot={open.bot} unread={open.unread} />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState icon={<SquaresFour size={28} />} title={t('bots.pick')} />
          </div>
        )}
      </main>
    </div>
  );
}
