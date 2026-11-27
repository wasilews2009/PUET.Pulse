import { ShieldCheck, SignIn } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { API_BASE } from '../api/client';
import { InlineError } from '../components/ui';
import { LanguageSwitch } from '../features/shell/LanguageSwitch';
import { safeReturnTo } from '../session/session';

/**
 * Splash / SSO screen. There is no password form: authentication happens at
 * the university IdP (Keycloak / AD) with OIDC + PKCE; MFA is enforced there.
 */
export function LoginPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const error = params.get('error');

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-6 bg-bg px-4 py-12">
      <div className="w-full max-w-md overflow-hidden rounded-3xl border border-line bg-surface shadow-xl">
        <div className="bg-white px-8 py-8">
          {/* Clear space ≥ 15% of the mark: padding around the official horizontal logo. */}
          <img src="/logo-puet-full.svg" alt={t('app.university')} className="mx-auto h-auto w-full max-w-xs" />
          <p className="mt-4 text-center font-heading text-sm leading-5 font-medium text-[#163C56]">Полтавський університет економіки і торгівлі</p>
        </div>
        <div className="flex flex-col gap-4 px-8 py-8">
          <div className="flex flex-col gap-2">
            <h1 className="heading-5">{t('login.title')}</h1>
            <p className="body-6 text-muted">{t('login.subtitle')}</p>
          </div>
          {error === 'access_denied' && <InlineError>{t('login.denied')}</InlineError>}
          {error === 'mfa_required' && <InlineError>{t('login.mfaRequired')}</InlineError>}
          {error === 'unavailable' && <InlineError>{t('login.unavailable')}</InlineError>}
          <a
            href={`${API_BASE}/auth/login?returnTo=${encodeURIComponent(returnTo)}`}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 button-md text-on-accent transition-colors duration-300 ease-pulse hover:bg-accent-hover active:scale-[0.98]"
          >
            <SignIn size={20} weight="bold" aria-hidden="true" />
            {t('login.sso')}
          </a>
          <p className="flex items-start gap-2 caption-5 text-muted">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
            {t('login.mfaNote')}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-4 caption-4 text-muted">
        <LanguageSwitch />
      </div>
    </main>
  );
}
