import { DownloadSimple, Eye, File, FilePdf, FileImage, FileText, Lock, ShieldCheck, Spinner, Warning } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { API_BASE } from '../../api/client';
import { useCard, useFiles } from '../../api/queries';
import type { Channel, FileItem } from '../../api/types';
import { Badge, EmptyState, InlineError, Skeleton, formatBytes, formatDateTime } from '../../components/ui';
import { pick } from '../../i18n';

function TypeIcon({ f }: { f: FileItem }) {
  const Icon = f.mimeType === 'application/pdf' ? FilePdf : f.mimeType.startsWith('image/') ? FileImage : f.mimeType.startsWith('text/') ? FileText : File;
  return <Icon size={28} aria-hidden="true" className="shrink-0 text-primary" />;
}

function Row({ f }: { f: FileItem }) {
  const { t, i18n } = useTranslation();
  const uploader = useCard(f.uploaderId);
  const ready = f.status === 'READY';
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <TypeIcon f={f} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate body-5">{f.fileName}</span>
          {f.confidential && (
            <Badge tone="accent">
              <Lock size={12} aria-hidden="true" />
              {t('files.confidential')}
            </Badge>
          )}
        </span>
        <span className="caption-5 text-muted">
          {[
            formatBytes(f.sizeBytes, i18n.language),
            f.pageCount ? t('files.pages', { count: f.pageCount }) : null,
            uploader.data ? pick(i18n.language, uploader.data.fullNameUk, uploader.data.fullNameEn) : null,
            formatDateTime(f.createdAt, i18n.language),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      <span className="flex items-center gap-1 caption-4">
        {f.status === 'PENDING' && <Spinner size={16} className="motion-safe:animate-spin text-muted" aria-hidden="true" />}
        {f.status === 'READY' && <ShieldCheck size={16} className="text-success" aria-hidden="true" />}
        {(f.status === 'REJECTED' || f.status === 'FAILED') && <Warning size={16} className="text-danger" aria-hidden="true" />}
        <span className={f.status === 'READY' ? 'text-muted' : f.status === 'PENDING' ? 'text-muted' : 'text-danger'}>{t(`files.status.${f.status}`)}</span>
      </span>
      {ready && (
        <span className="flex gap-2">
          {f.viewable && (
            <Link to={`/files/${f.id}`} className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1 button-sm text-on-primary hover:bg-primary-hover">
              <Eye size={16} aria-hidden="true" />
              {t('files.open')}
            </Link>
          )}
          {!f.confidential && (
            <a
              href={`${API_BASE}/files/${f.id}/download`}
              className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1 button-sm text-ink hover:bg-surface-hover"
            >
              <DownloadSimple size={16} aria-hidden="true" />
              {t('files.download')}
            </a>
          )}
        </span>
      )}
    </li>
  );
}

export function FileList({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const files = useFiles(channel.id);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <h3 className="sr-only">{t('files.title')}</h3>
      {files.isPending && (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      )}
      {files.isError && <InlineError>{t('app.error')}</InlineError>}
      {files.data?.length === 0 && <EmptyState icon={<File size={28} />} title={t('files.empty')} hint={t('files.emptyHint')} />}
      <ul className="flex flex-col gap-2">
        {files.data?.map((f) => (
          <Row key={f.id} f={f} />
        ))}
      </ul>
    </div>
  );
}
