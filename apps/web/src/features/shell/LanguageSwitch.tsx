import { useTranslation } from 'react-i18next';
import { cx } from '../../components/ui';
import { setLang, type Lang } from '../../i18n';

export function LanguageSwitch({ tone = 'default' }: { tone?: 'default' | 'sidebar' }) {
  const { i18n, t } = useTranslation();
  return (
    <div role="group" aria-label={t('nav.language')} className={cx('inline-flex rounded-lg p-0.5', tone === 'sidebar' ? 'bg-sidebar-hover' : 'bg-surface-hover')}>
      {(['uk', 'en'] as Lang[]).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={i18n.language === l}
          onClick={() => setLang(l)}
          className={cx(
            'rounded-md px-2 py-1 caption-3 uppercase transition-colors duration-300 ease-pulse',
            i18n.language === l ? (tone === 'sidebar' ? 'bg-sidebar-text text-sidebar' : 'bg-surface text-ink shadow-sm') : tone === 'sidebar' ? 'text-sidebar-muted' : 'text-muted',
          )}
        >
          {l === 'uk' ? 'UA' : 'EN'}
        </button>
      ))}
    </div>
  );
}
