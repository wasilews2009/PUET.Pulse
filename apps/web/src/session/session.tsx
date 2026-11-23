import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation } from 'react-router';
import { api, ApiError } from '../api/client';
import type { Me } from '../api/types';
import { hasStoredLang, setLang } from '../i18n';
import { applyOverrides } from '../theme/overrides';
import { FullScreenLoader } from '../components/FullScreenLoader';

const Ctx = createContext<Me | null>(null);

export const ADMIN_ROLES = ['SUPER_ADMIN', 'RECTORATE', 'INSTITUTE_DIRECTOR'];

/** The signed-in principal. Everything under it can assume a session exists. */
export function useMe(): Me {
  const me = useContext(Ctx);
  if (!me) throw new Error('useMe outside SessionGate');
  return me;
}

export const isAdmin = (me: Me) => me.roles.some((r) => ADMIN_ROLES.includes(r.role));

/** Same-site relative path only, matching the API's own returnTo rule. */
export function safeReturnTo(path: string | null | undefined): string {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return '/';
  return path;
}

export function SessionGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { i18n } = useTranslation();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/auth/me'),
    retry: (n, e) => !(e instanceof ApiError && (e.status === 401 || e.status === 403)) && n < 2,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!me.data) return;
    if (!hasStoredLang() && me.data.locale !== i18n.language) setLang(me.data.locale, false);
    applyOverrides(me.data.themeOverrides);
  }, [me.data, i18n.language]);

  if (me.isPending) return <FullScreenLoader />;
  if (me.error) {
    const returnTo = encodeURIComponent(safeReturnTo(location.pathname + location.search));
    return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  }
  return <Ctx.Provider value={me.data}>{children}</Ctx.Provider>;
}

export async function logout(qc: ReturnType<typeof useQueryClient>) {
  try {
    const r = await api<{ endSessionUrl: string | null }>('/auth/logout', { method: 'POST' });
    qc.clear();
    window.location.assign(r.endSessionUrl && /^https:\/\//.test(r.endSessionUrl) ? r.endSessionUrl : '/login');
  } catch {
    qc.clear();
    window.location.assign('/login');
  }
}
