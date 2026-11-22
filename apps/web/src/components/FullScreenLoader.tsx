import { useTranslation } from 'react-i18next';

export function FullScreenLoader() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center bg-bg" role="status" aria-live="polite">
      <img src="/logo-puet-mark.svg" alt="" className="size-16 motion-safe:animate-pulse" />
      <span className="sr-only">{t('app.loading')}</span>
    </div>
  );
}
