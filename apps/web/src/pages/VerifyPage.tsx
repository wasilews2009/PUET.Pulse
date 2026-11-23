import { CheckCircle, UploadSimple, XCircle } from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { api, ApiError, isUuid } from '../api/client';
import type { VerificationProtocol } from '../api/types';
import { EmptyState, InlineError, Skeleton } from '../components/ui';
import { LanguageSwitch } from '../features/shell/LanguageSwitch';
import { ProtocolView } from '../features/signatures/Protocol';

const CODE = /^[A-Za-z0-9_-]{26}$/;

/**
 * Public page behind the QR code on a signed document. The unguessable code is
 * the capability; wrong codes look exactly like missing documents, and the
 * file name is never shown. A recipient can compare their copy byte for byte.
 */
export default function VerifyPage() {
  const { t } = useTranslation();
  const { fileId, code } = useParams();
  const valid = isUuid(fileId) && !!code && CODE.test(code);
  const q = useQuery({
    queryKey: ['public-verify', fileId, code],
    queryFn: () => api<VerificationProtocol>(`/verify/${fileId}/${code}`),
    enabled: valid,
    retry: false,
  });
  const check = useMutation({
    mutationFn: async (file: File) =>
      api<{ matches: boolean }>(`/verify/${fileId}/${code}/check`, { method: 'POST', body: new Uint8Array(await file.arrayBuffer()) }),
  });

  return (
    <main className="min-h-full bg-bg px-4 py-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <header className="flex items-center justify-between gap-4">
          <div className="rounded-2xl bg-white px-4 py-3">
            <img src="/logo-puet-full.svg" alt="Poltava University of Economics and Trade" className="h-10 w-auto" />
          </div>
          <LanguageSwitch />
        </header>
        <section className="flex flex-col gap-4 rounded-3xl border border-line bg-surface p-6 shadow-sm">
          <div>
            <h1 className="heading-5">{t('verification.publicTitle')}</h1>
            <p className="body-6 text-muted">{t('verification.publicHint')}</p>
          </div>
          {!valid || (q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 400)) ? (
            <EmptyState icon={<XCircle size={28} />} title={t('verification.notFound')} />
          ) : q.isPending ? (
            <Skeleton className="h-64" />
          ) : q.isError ? (
            <InlineError>{t('app.error')}</InlineError>
          ) : (
            <>
              <ProtocolView p={q.data} publicView />
              <div className="flex flex-col gap-2 rounded-xl border border-dashed border-line p-4">
                <h2 className="title-3">{t('verification.compare')}</h2>
                <p className="caption-5 text-muted">{t('verification.compareHint')}</p>
                <label className="inline-flex cursor-pointer items-center gap-2 self-start rounded-lg bg-primary px-3 py-2 button-md text-on-primary hover:bg-primary-hover">
                  <UploadSimple size={20} aria-hidden="true" />
                  {t('verification.compare')}
                  <input type="file" className="sr-only" onChange={(e) => e.target.files?.[0] && check.mutate(e.target.files[0])} />
                </label>
                {check.data && (
                  <p role="status" className={`flex items-center gap-2 body-5 ${check.data.matches ? 'text-success' : 'text-danger'}`}>
                    {check.data.matches ? <CheckCircle size={20} weight="fill" aria-hidden="true" /> : <XCircle size={20} weight="fill" aria-hidden="true" />}
                    {check.data.matches ? t('verification.matches') : t('verification.differs')}
                  </p>
                )}
                {check.isError && <InlineError>{t('app.error')}</InlineError>}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
