import { Compass } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { EmptyState } from '../components/ui';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <main id="main" className="flex flex-1 items-center justify-center">
      <EmptyState
        icon={<Compass size={28} />}
        title={t('notFound.title')}
        hint={t('notFound.hint')}
        action={
          <Link to="/chats" className="rounded-lg bg-primary px-3 py-2 button-md text-on-primary hover:bg-primary-hover">
            {t('notFound.home')}
          </Link>
        }
      />
    </main>
  );
}
