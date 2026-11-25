import { Bell, Certificate as CertIcon, DeviceMobile, Key, Moon, Palette, ShieldCheck, User } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { keys } from '../../api/queries';
import type { Certificate, QuietHours } from '../../api/types';
import { Badge, Button, cx, Field, InlineError, Input, Skeleton, Toggle, formatDateTime } from '../../components/ui';
import { pick } from '../../i18n';
import { currentDeviceId, getCrypto } from '../../e2ee/crypto';
import { useMe } from '../../session/session';
import { useTheme, type ThemeChoice } from '../../theme/theme';
import { LanguageSwitch } from '../shell/LanguageSwitch';
import { disablePush, enablePush, pushState, type PushState } from '../shell/push';
import { deleteKey, saveKey } from '../signatures/keystore';
import { useLocalCertificate } from '../signatures/SignDialog';

function Card({ id, icon, title, hint, children }: { id?: string; icon: ReactNode; title: string; hint?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id ?? title}-h`} className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6">
      <header className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-hover text-primary">{icon}</span>
        <div>
          <h2 id={`${id ?? title}-h`} className="heading-6">
            {title}
          </h2>
          {hint && <p className="body-6 text-muted">{hint}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}

const toHm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromHm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

function QuietHoursCard() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['quiet-hours'], queryFn: () => api<QuietHours>('/me/quiet-hours') });
  const [v, setV] = useState<QuietHours | null>(null);
  useEffect(() => {
    if (q.data) setV(q.data);
  }, [q.data]);
  const save = useMutation({ mutationFn: (body: QuietHours) => api<QuietHours>('/me/quiet-hours', { method: 'PUT', body: { ...body } }) });
  const days = t('settings.days', { returnObjects: true }) as string[];
  return (
    <Card icon={<Moon size={22} />} title={t('settings.quietHours')} hint={t('settings.quietHoursHint')}>
      {!v ? (
        <Skeleton className="h-24" />
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(v);
          }}
        >
          <Toggle checked={v.enabled} onChange={(enabled) => setV({ ...v, enabled })} label={t('settings.enabled')} />
          <div className="flex flex-wrap gap-4">
            <Field label={t('settings.from')}>{(id) => <Input id={id} type="time" value={toHm(v.startMinute)} onChange={(e) => setV({ ...v, startMinute: fromHm(e.target.value) })} />}</Field>
            <Field label={t('settings.to')}>{(id) => <Input id={id} type="time" value={toHm(v.endMinute)} onChange={(e) => setV({ ...v, endMinute: fromHm(e.target.value) })} />}</Field>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 title-4">{t('settings.weekdays')}</legend>
            <div className="flex flex-wrap gap-2">
              {days.map((d, i) => {
                const n = i + 1;
                const on = v.weekdays.includes(n);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setV({ ...v, weekdays: on ? v.weekdays.filter((x) => x !== n) : [...v.weekdays, n].sort() })}
                    className={cx('min-w-12 rounded-lg border px-3 py-1 button-sm transition-colors duration-300 ease-pulse', on ? 'border-primary bg-primary text-on-primary' : 'border-line text-muted hover:bg-surface-hover')}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <Toggle checked={v.digestEnabled} onChange={(digestEnabled) => setV({ ...v, digestEnabled })} label={t('settings.digest')} />
          <div className="flex items-center gap-3">
            <Button type="submit" loading={save.isPending}>
              {t('app.save')}
            </Button>
            {save.isSuccess && <span role="status" className="caption-4 text-success">{t('app.saved')}</span>}
            {save.isError && <span className="caption-4 text-danger">{t('app.error')}</span>}
          </div>
        </form>
      )}
    </Card>
  );
}

function CertificatesCard() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const { cert: localCert, certs } = useLocalCertificate();
  const create = useMutation({
    mutationFn: async () => {
      const { generateSigningKeyPair, createCsr } = await import('@puet/signing');
      // Non-extractable ECDSA P-256 key: generated here, never exported, never sent.
      const pair = await generateSigningKeyPair();
      const csr = await createCsr(pair);
      const cert = await api<Certificate>('/me/certificates', { method: 'POST', body: { csr } });
      await saveKey({ userId: me.userId, privateKey: pair.privateKey, publicKey: pair.publicKey, certificateId: cert.id, createdAt: new Date().toISOString() });
      return cert;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.certificates });
      void qc.invalidateQueries({ queryKey: ['local-key', me.userId] });
    },
  });
  const revoke = useMutation({
    mutationFn: async (c: Certificate) => {
      await api(`/me/certificates/${c.id}/revoke`, { method: 'POST', body: { reason: 'UNSPECIFIED' } });
      if (c.id === localCert?.id) await deleteKey(me.userId);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.certificates });
      void qc.invalidateQueries({ queryKey: ['local-key', me.userId] });
    },
  });
  const tone = (s: string) => (s === 'ACTIVE' ? 'success' : s === 'REVOKED' ? 'danger' : 'neutral');

  return (
    <Card id="certificates" icon={<CertIcon size={22} />} title={t('settings.certificates')} hint={t('settings.certificatesHint')}>
      {create.isError && <InlineError>{t('app.error')}</InlineError>}
      {certs.isPending ? (
        <Skeleton className="h-16" />
      ) : certs.data?.length === 0 ? (
        <p className="body-6 text-muted">{t('settings.noCertificates')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {certs.data?.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-4 py-3">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 body-5">
                  {c.provider === 'EXTERNAL_QES' ? 'КЕП' : 'УЕП'}
                  <Badge tone={tone(c.status)}>{t(`settings.certStatus.${c.status}`, { defaultValue: c.status })}</Badge>
                  {c.id === localCert?.id && <Badge tone="navy">{t('settings.keyHere')}</Badge>}
                </span>
                <span className="truncate caption-5 text-muted">{c.subjectDn}</span>
                <span className="caption-5 text-muted">{t('settings.validUntil', { date: formatDateTime(c.notAfter, i18n.language) })}</span>
              </span>
              {c.status === 'ACTIVE' && c.provider === 'INTERNAL_PKI' && (
                <Button size="sm" variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate(c)}>
                  {t('settings.revoke')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Button variant="accent" className="self-start" loading={create.isPending} icon={<Key size={18} />} onClick={() => create.mutate()}>
        {create.isPending ? t('settings.creating') : t('settings.createCertificate')}
      </Button>
    </Card>
  );
}

function E2eeCard() {
  const { t } = useTranslation();
  const me = useMe();
  const [pass, setPass] = useState('');
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<{ id: string; label: string; createdAt: string; verifiedAt: string | null }[]>('/e2ee/devices') });
  const backup = useQuery({ queryKey: ['backup-version'], queryFn: () => api<{ version: string } | null>('/e2ee/room_keys/version').catch(() => null) });
  const enable = useMutation({
    mutationFn: async () => (await getCrypto(me.userId)).enableBackup(pass),
    onSuccess: () => {
      setPass('');
      void backup.refetch();
    },
  });
  const restore = useMutation({ mutationFn: async () => (await getCrypto(me.userId)).restoreBackup(pass), onSuccess: () => setPass('') });
  const thisDevice = currentDeviceId(me.userId);
  const valid = pass.length >= 12;
  return (
    <Card icon={<ShieldCheck size={22} />} title={t('settings.e2ee')} hint={t('settings.e2eeHint')}>
      {backup.data && (
        <Badge tone="success" className="self-start">
          {t('settings.backupOn')}
        </Badge>
      )}
      <form className="flex flex-col gap-3" onSubmit={(e) => e.preventDefault()}>
        <input type="text" name="username" autoComplete="username" value={me.corporateId ?? ''} readOnly hidden />
        <Field label={t('settings.passphrase')} hint={t('settings.passphraseHint')}>
          {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />}
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button disabled={!valid} loading={enable.isPending} onClick={() => enable.mutate()}>
            {t('settings.enableBackup')}
          </Button>
          <Button variant="secondary" disabled={!valid || !backup.data} loading={restore.isPending} onClick={() => restore.mutate()}>
            {t('settings.restoreBackup')}
          </Button>
        </div>
        {(enable.isError || restore.isError) && <InlineError>{t('app.error')}</InlineError>}
        {restore.data !== undefined && <p role="status" className="caption-4 text-success">{t('settings.restored', { count: restore.data })}</p>}
      </form>
      <div className="flex flex-col gap-2">
        <h3 className="title-4">{t('settings.devices')}</h3>
        <ul className="flex flex-col gap-2">
          {devices.data?.map((d) => (
            <li key={d.id} className="flex items-center gap-3 rounded-xl border border-line px-4 py-2">
              <DeviceMobile size={20} aria-hidden="true" className="text-primary" />
              <span className="flex-1 body-6">{d.label}</span>
              {d.id === thisDevice && <Badge tone="navy">{t('settings.thisDevice')}</Badge>}
              <Badge tone={d.verifiedAt ? 'success' : 'neutral'}>{d.verifiedAt ? t('settings.verified') : t('settings.unverified')}</Badge>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function PushCard() {
  const { t } = useTranslation();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void pushState().then(setState).catch(() => setState('off'));
  }, []);
  const run = (f: () => Promise<PushState>) => {
    setBusy(true);
    void f()
      .then(setState)
      .catch(() => setState('unavailable'))
      .finally(() => setBusy(false));
  };
  const message = state === 'on' ? t('push.on') : state === 'off' ? t('push.off') : state ? t(`push.${state}`) : '';
  return (
    <Card id="push" icon={<Bell size={22} />} title={t('push.title')} hint={t('push.hint')}>
      <div className="flex flex-wrap items-center gap-3">
        {state === 'on' ? <Badge tone="success">{message}</Badge> : <p className="body-6 text-muted">{message}</p>}
        {state === 'off' && (
          <Button size="sm" icon={<Bell size={16} />} loading={busy} onClick={() => run(() => enablePush(true))}>
            {t('push.enable')}
          </Button>
        )}
        {state === 'on' && (
          <Button variant="secondary" size="sm" loading={busy} onClick={() => run(() => disablePush().then(() => 'off' as const))}>
            {t('push.disable')}
          </Button>
        )}
      </div>
    </Card>
  );
}

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const { choice, setChoice } = useTheme();
  return (
    <main id="main" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
        <h1 className="heading-5">{t('settings.title')}</h1>

        <Card icon={<User size={22} />} title={t('settings.profile')}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 body-6">
            <dt className="text-muted">{t('admin.user')}</dt>
            <dd className="body-5">{pick(i18n.language, me.fullNameUk, me.fullNameEn)}</dd>
            {me.corporateId && (
              <>
                <dt className="text-muted">ID</dt>
                <dd className="font-mono">{me.corporateId}</dd>
              </>
            )}
            <dt className="text-muted">{t('admin.roles')}</dt>
            <dd className="flex flex-wrap gap-1">
              {me.roles.map((r) => (
                <Badge key={`${r.role}-${JSON.stringify(r.scope)}`} tone="navy">
                  {r.role}
                </Badge>
              ))}
            </dd>
            <dt className="text-muted">{t('settings.mfa')}</dt>
            <dd>{me.mfaVerified ? <Badge tone="success">{t('settings.mfaOn')}</Badge> : <Badge>{t('settings.mfaOff')}</Badge>}</dd>
          </dl>
        </Card>

        <Card icon={<Palette size={22} />} title={t('settings.appearance')}>
          <div className="flex flex-wrap items-center gap-6">
            <div role="radiogroup" aria-label={t('nav.theme')} className="inline-flex rounded-lg bg-surface-hover p-0.5">
              {(['light', 'dark', 'system'] as ThemeChoice[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={choice === c}
                  onClick={() => setChoice(c)}
                  className={cx('rounded-md px-3 py-1 button-sm transition-colors duration-300 ease-pulse', choice === c ? 'bg-surface text-ink shadow-sm' : 'text-muted')}
                >
                  {t(c === 'light' ? 'settings.themeLight' : c === 'dark' ? 'settings.themeDark' : 'settings.themeSystem')}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 body-6">
              {t('settings.language')}
              <LanguageSwitch />
            </div>
          </div>
        </Card>

        <PushCard />
        <QuietHoursCard />
        <CertificatesCard />
        <E2eeCard />
      </div>
    </main>
  );
}
