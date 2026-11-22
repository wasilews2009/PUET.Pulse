import { CheckCircle, FilePdf, Seal, SealCheck, ShieldWarning, XCircle } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, API_BASE } from '../../api/client';
import { keys } from '../../api/queries';
import type { VerificationProtocol } from '../../api/types';
import { Badge, cx, Dialog, InlineError, Skeleton, formatDateTime } from '../../components/ui';

function svgDataUrl(svg: string) {
  // Rendered as an <img>: an SVG image cannot run scripts or load anything.
  let bin = '';
  for (const b of new TextEncoder().encode(svg)) bin += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

const certTone = (s: string) => (s === 'ACTIVE' ? 'success' : s === 'REVOKED' ? 'danger' : 'neutral');

/** The verification protocol: integrity, each signature re-checked, approval route, QR. */
export function ProtocolView({ p, publicView = false }: { p: VerificationProtocol; publicView?: boolean }) {
  const { t, i18n } = useTranslation();
  const intact = p.document.integrity === 'intact';
  return (
    <div className="flex flex-col gap-4">
      <div className={cx('flex items-center gap-3 rounded-xl px-4 py-3', intact ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger')}>
        {intact ? <SealCheck size={28} weight="fill" aria-hidden="true" /> : <ShieldWarning size={28} weight="fill" aria-hidden="true" />}
        <span className="body-4">{intact ? t('verification.intact') : t('verification.modified')}</span>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 caption-5">
        {!publicView && p.document.fileName && (
          <>
            <dt className="text-muted">{t('verification.document')}</dt>
            <dd className="body-5 break-words">{p.document.fileName}</dd>
          </>
        )}
        <dt className="text-muted">{t('verification.sha')}</dt>
        <dd className="font-mono break-all">{p.document.sha256}</dd>
        {p.document.pages !== null && (
          <>
            <dt className="text-muted">{t('verification.pages')}</dt>
            <dd>{p.document.pages}</dd>
          </>
        )}
        <dt className="text-muted">{t('verification.checkedAt')}</dt>
        <dd>{formatDateTime(p.checkedAt, i18n.language)}</dd>
      </dl>

      {p.signatures.length === 0 && <p className="body-6 text-muted">{t('verification.none')}</p>}
      <ul className="flex flex-col gap-3">
        {p.signatures.map((s) => (
          <li key={s.id} className="rounded-xl border border-line bg-surface px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 body-4">
                {s.valid ? <CheckCircle size={20} weight="fill" className="text-success" aria-hidden="true" /> : <XCircle size={20} weight="fill" className="text-danger" aria-hidden="true" />}
                {s.signer.fullName}
              </span>
              <span className="flex gap-1">
                <Badge tone={s.level === 'КЕП' ? 'navy' : 'neutral'}>{s.level}</Badge>
                <Badge tone={s.valid ? 'success' : 'danger'}>{s.valid ? t('verification.valid') : t('verification.invalid')}</Badge>
              </span>
            </div>
            {s.signer.title && <p className="caption-5 text-muted">{s.signer.title}</p>}
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 caption-5">
              <dt className="text-muted">{t('verification.signedAt')}</dt>
              <dd>{formatDateTime(s.signedAt, i18n.language)}</dd>
              {s.tspTime && (
                <>
                  <dt className="text-muted">{t('verification.tsp')}</dt>
                  <dd>{formatDateTime(s.tspTime, i18n.language)}</dd>
                </>
              )}
              <dt className="text-muted">{t('verification.serial')}</dt>
              <dd className="font-mono break-all">{s.certificate.serialNumber}</dd>
              <dt className="text-muted">{t('verification.issuer')}</dt>
              <dd className="break-words">{s.certificate.issuer}</dd>
              <dt className="text-muted">{t('verification.status')}</dt>
              <dd>
                <Badge tone={certTone(s.certificate.status)}>{t(`settings.certStatus.${s.certificate.status}`, { defaultValue: s.certificate.status })}</Badge>
              </dd>
            </dl>
            {s.valid && s.certificate.revokedAt && <p className="mt-2 caption-5 text-muted">{t('verification.revokedLater')}</p>}
          </li>
        ))}
      </ul>

      {p.approval && (
        <section className="flex flex-col gap-2">
          <h3 className="title-3">
            {t('viewer.route')}
            {p.approval.title ? `: ${p.approval.title}` : ''}
          </h3>
          <ol className="flex flex-col gap-1">
            {p.approval.steps.map((s) => (
              <li key={s.position} className="flex items-center justify-between gap-2 body-6">
                <span>
                  {s.position}. {s.approverName}
                </span>
                <Badge tone={s.status === 'APPROVED' ? 'success' : s.status === 'REJECTED' ? 'danger' : 'neutral'}>{t(`approvals.status.${s.status}`, { defaultValue: s.status })}</Badge>
              </li>
            ))}
          </ol>
        </section>
      )}

      {p.qrSvg && (
        <figure className="flex items-center gap-4 rounded-xl border border-line px-4 py-3">
          <img src={svgDataUrl(p.qrSvg)} alt={t('verification.qr')} className="size-28 rounded-lg bg-white p-1" />
          <figcaption className="caption-5 break-all text-muted">{p.verifyUrl}</figcaption>
        </figure>
      )}
    </div>
  );
}

export function VerificationDialog({ fileId, open, onClose }: { fileId: string; open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const q = useQuery({ queryKey: keys.verification(fileId), queryFn: () => api<VerificationProtocol>(`/files/${fileId}/verification`), enabled: open });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('verification.title')}
      footer={
        <a
          href={`${API_BASE}/files/${fileId}/verification.pdf?lang=${i18n.language === 'en' ? 'en' : 'uk'}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 button-md text-on-primary hover:bg-primary-hover"
        >
          <FilePdf size={20} aria-hidden="true" />
          {t('verification.pdf')}
        </a>
      }
    >
      {q.isPending && <Skeleton className="h-48" />}
      {q.isError && <InlineError>{t('app.error')}</InlineError>}
      {q.data && <ProtocolView p={q.data} />}
    </Dialog>
  );
}

/** «Підписано ЕП» badge (navy / green): opens the verification modal. */
export function SignedBadge({ fileId, count }: { fileId: string; count: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-full bg-navy px-3 py-1 caption-3 text-white ring-2 ring-success/60 transition-transform duration-300 ease-pulse hover:scale-[1.02] active:scale-[0.98]"
      >
        <Seal size={16} weight="fill" className="text-[#7ED3A6]" aria-hidden="true" />
        {t('verification.badge')}
        {count > 1 ? ` · ${count}` : ''}
      </button>
      <VerificationDialog fileId={fileId} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
