import { Stamp } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { BotFeed } from './BotFeed';

/** «ЕДО та Канцелярія»: approval notifications; the decisions themselves live on the approvals page. */
export function ChancelleryPanel() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
        <Stamp size={24} aria-hidden="true" className="text-primary" />
        <p className="min-w-0 flex-1 body-6 text-muted">{t('bots.chancellery.hint')}</p>
        <Link to="/approvals" className="button-sm rounded-lg bg-primary px-3 py-1 text-on-primary transition-colors duration-300 ease-pulse hover:bg-primary-hover">
          {t('bots.chancellery.approvals')}
        </Link>
      </div>
      <BotFeed bot="chancellery" />
    </div>
  );
}
