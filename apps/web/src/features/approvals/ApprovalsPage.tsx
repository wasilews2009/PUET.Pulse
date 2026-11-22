import { Eye, Stamp } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApprovals } from '../../api/queries';
import { EmptyState, InlineError, Skeleton } from '../../components/ui';
import { RouteView } from './RoutePanel';

export default function ApprovalsPage() {
  const { t } = useTranslation();
  const q = useApprovals();
  return (
    <main id="main" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
        <header>
          <h1 className="heading-5">{t('approvals.title')}</h1>
          <p className="body-6 text-muted">{t('approvals.inbox')}</p>
        </header>
        {q.isPending && (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
          </div>
        )}
        {q.isError && <InlineError>{t('app.error')}</InlineError>}
        {q.data?.length === 0 && <EmptyState icon={<Stamp size={28} />} title={t('approvals.empty')} hint={t('approvals.emptyHint')} />}
        <ul className="flex flex-col gap-3">
          {q.data?.map((r) => (
            <li key={r.id} className="flex flex-col gap-2">
              {r.file && (
                <Link to={`/files/${r.file.id}`} className="inline-flex items-center gap-2 self-start rounded-lg px-1 body-5 text-primary hover:underline">
                  <Eye size={18} aria-hidden="true" />
                  {r.file.fileName}
                </Link>
              )}
              <RouteView route={r} />
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
