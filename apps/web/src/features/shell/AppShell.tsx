import { CalendarCheck, ChatsCircle, GearSix, Moon, ShieldStar, SignOut, Sun, Stamp } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import { useApprovals, useChannels } from '../../api/queries';
import { cx, IconButton } from '../../components/ui';
import { pick } from '../../i18n';
import { isAdmin, logout, useMe } from '../../session/session';
import { useTheme } from '../../theme/theme';
import { CallProvider } from '../calls/CallContext';
import { PresenceMenu } from './PresenceMenu';
import { useRealtime } from './useRealtime';

function RailLink({ to, label, icon, badge }: { to: string; label: string; icon: ReactNode; badge?: number }) {
  return (
    <NavLink
      to={to}
      aria-label={label}
      title={label}
      className={({ isActive }) =>
        cx(
          'relative flex size-12 items-center justify-center rounded-xl transition-colors duration-300 ease-pulse',
          isActive ? 'bg-sidebar-text/15 text-sidebar-text' : 'text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-text',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <span aria-hidden="true" className="absolute top-3 bottom-3 -left-3 w-1 rounded-full bg-accent" />}
          {icon}
          {badge ? (
            <span className="absolute -top-0.5 -right-0.5 min-w-5 rounded-full bg-accent px-1 text-center caption-3 text-on-accent ring-2 ring-sidebar">{badge > 99 ? '99+' : badge}</span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

function TabLink({ to, label, icon, badge }: { to: string; label: string; icon: ReactNode; badge?: number }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => cx('relative flex flex-1 flex-col items-center gap-0.5 py-2 caption-4', isActive ? 'text-primary' : 'text-muted')}
    >
      {icon}
      {label}
      {badge ? <span className="absolute top-1 left-1/2 ml-2 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 font-semibold text-on-accent">{badge > 99 ? '99+' : badge}</span> : null}
    </NavLink>
  );
}

/** Authenticated layout: navy navigation rail (desktop) or bottom tabs (phone), realtime bridge. */
export function AppShell() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const { resolved, setChoice } = useTheme();
  const channels = useChannels();
  const approvals = useApprovals();
  const { connected } = useRealtime();
  const unread = (channels.data ?? []).filter((c) => !c.mutedUntil).reduce((n, c) => n + c.unread, 0);
  const pendingApprovals = approvals.data?.length ?? 0;
  const admin = isAdmin(me);
  const name = pick(i18n.language, me.fullNameUk, me.fullNameEn);

  return (
    <CallProvider>
    <div className="flex h-full flex-col md:flex-row">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2">
        {t('app.skip')}
      </a>
      <nav aria-label="PUET.Pulse" className="hidden w-20 shrink-0 flex-col items-center gap-2 bg-sidebar py-4 md:flex">
        <img src="/logo-puet-mark.svg" alt="PUET" className="mb-4 size-11" />
        <RailLink to="/chats" label={t('nav.chats')} icon={<ChatsCircle size={26} />} badge={unread} />
        <RailLink to="/consultations" label={t('nav.consultations')} icon={<CalendarCheck size={26} />} />
        <RailLink to="/approvals" label={t('nav.approvals')} icon={<Stamp size={26} />} badge={pendingApprovals} />
        {admin && <RailLink to="/admin" label={t('nav.admin')} icon={<ShieldStar size={26} />} />}
        <RailLink to="/settings" label={t('nav.settings')} icon={<GearSix size={26} />} />
        <div className="mt-auto flex flex-col items-center gap-2">
          <IconButton tone="sidebar" label={t('nav.theme')} onClick={() => setChoice(resolved === 'dark' ? 'light' : 'dark')}>
            {resolved === 'dark' ? <Sun size={22} /> : <Moon size={22} />}
          </IconButton>
          <PresenceMenu name={name} />
          <IconButton tone="sidebar" label={t('nav.logout')} onClick={() => void logout(qc)}>
            <SignOut size={22} />
          </IconButton>
        </div>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!connected && (
          <p role="status" className="bg-accent px-4 py-1 text-center caption-4 text-on-accent">
            {t('app.offline')}
          </p>
        )}
        <Outlet />
      </div>

      <nav aria-label="PUET.Pulse" className="flex shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
        <TabLink to="/chats" label={t('nav.chats')} icon={<ChatsCircle size={24} />} badge={unread} />
        <TabLink to="/consultations" label={t('nav.consultationsShort')} icon={<CalendarCheck size={24} />} />
        <TabLink to="/approvals" label={t('nav.approvals')} icon={<Stamp size={24} />} badge={pendingApprovals} />
        {admin && <TabLink to="/admin" label={t('nav.adminShort')} icon={<ShieldStar size={24} />} />}
        <TabLink to="/settings" label={t('nav.settings')} icon={<GearSix size={24} />} />
      </nav>
    </div>
    </CallProvider>
  );
}
