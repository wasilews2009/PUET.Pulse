import { ArrowLeft, LockKey, PaperPlaneRight, ShieldCheck, UserCircleDashed } from '@phosphor-icons/react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { keys, upsertMessage } from '../../api/queries';
import type { Member, Message, TrustCase, TrustServices } from '../../api/types';
import { Badge, Button, cx, Dialog, EmptyState, formatDateTime, formatTime, InlineError, Skeleton, TextArea } from '../../components/ui';
import { getPersonaCrypto, personaHeaders } from '../../e2ee/crypto';
import { pick } from '../../i18n';
import { statusOf } from '../bots/bot-meta';

export const trustKeys = {
  services: ['trust', 'services'] as const,
  mine: ['trust', 'mine'] as const,
};

export const useTrustServices = () =>
  useQuery({ queryKey: trustKeys.services, queryFn: () => api<TrustServices>('/trust-services'), staleTime: 5 * 60_000, retry: false });

const useMyAppeals = () => useQuery({ queryKey: trustKeys.mine, queryFn: () => api<TrustCase[]>('/me/appeals'), staleTime: 30_000 });

const MAX_TEXT = 4000;
/** Mirrors the server's limit of open appeals per person (the server decides). */
const MAX_OPEN_APPEALS = 5;

function clientId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decrypted with the pseudonym's own device; plaintext stays in memory only. */
function useAppealPlain(m: Message, pseudonymId: string) {
  return useQuery({
    queryKey: ['plain', m.id, m.editedAt ?? ''],
    enabled: !m.deleted && !!m.ciphertext,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: 1,
    queryFn: async () => {
      const c = await getPersonaCrypto(pseudonymId);
      const d = await c.decrypt({ id: m.id, channelId: m.channelId, senderId: m.senderId, createdAt: m.createdAt, ciphertext: m.ciphertext! });
      return { text: typeof d.content.body === 'string' ? d.content.body : '', encrypted: true, failed: false, verified: d.verified };
    },
  });
}

function AppealBubble({ m, pseudonymId }: { m: Message; pseudonymId: string }) {
  const { t, i18n } = useTranslation();
  const plain = useAppealPlain(m, pseudonymId);
  const mine = m.senderId === pseudonymId;
  return (
    <li className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
      <div className={cx('flex max-w-[85%] flex-col gap-1 rounded-2xl px-4 py-3 shadow-sm', mine ? 'bg-primary text-on-primary' : 'bg-surface ring-1 ring-line')}>
        {!mine && <span className="caption-3 text-primary">{t('trust.officer')}</span>}
        {/* Plain text only. */}
        <p className="body-6 whitespace-pre-wrap break-words">
          {m.deleted ? t('message.deleted') : plain.data ? plain.data.text : plain.isError ? t('trust.undecryptable') : '…'}
        </p>
        <time dateTime={m.createdAt} className={cx('self-end caption-5', mine ? 'text-on-primary/80' : 'text-muted')}>
          {formatTime(m.createdAt, i18n.language)}
        </time>
      </div>
    </li>
  );
}

/**
 * One appeal, seen as its pseudonym: every request carries X-Pulse-Persona and
 * messages are sealed by the pseudonym's own E2EE device, so nothing in the
 * room links back to the person's account or devices.
 */
function AppealChat({ c, onBack }: { c: TrustCase; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const headers = personaHeaders(c.pseudonymId);
  const [text, setText] = useState('');
  const [closing, setClosing] = useState(false);
  const bottom = useRef<HTMLLIElement>(null);
  const open = c.status === 'OPEN';

  const messages = useInfiniteQuery({
    queryKey: keys.messages(c.channelId, null),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: '50' });
      if (pageParam) q.set('before', pageParam);
      return api<Message[]>(`/channels/${c.channelId}/messages?${q}`, { headers });
    },
    getNextPageParam: (last) => (last.length < 50 ? undefined : last.at(-1)?.createdAt),
  });
  const list = [...(messages.data?.pages.flat() ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [list.length]);
  useEffect(() => {
    // Start the pseudonym's device early so the first message is not delayed.
    void getPersonaCrypto(c.pseudonymId).catch(() => undefined);
  }, [c.pseudonymId]);

  const send = useMutation({
    mutationFn: async (body: string) => {
      const members = await api<Member[]>(`/channels/${c.channelId}/members`, { headers });
      const crypto = await getPersonaCrypto(c.pseudonymId);
      const sealed = await crypto.encrypt(
        c.channelId,
        members.map((m) => m.userId),
        { msgtype: 'm.text', body },
      );
      const sent = await api<Message>(`/channels/${c.channelId}/messages`, {
        method: 'POST',
        headers,
        body: { clientMessageId: clientId(), ciphertext: sealed.ciphertext, scheme: sealed.scheme, senderDeviceId: crypto.machine.deviceId.toString() },
      });
      qc.setQueryData(['plain', sent.id, sent.editedAt ?? ''], { text: body, encrypted: true, failed: false, verified: true });
      return sent;
    },
    onSuccess: (m) => {
      upsertMessage(qc, m);
      setText('');
    },
  });

  const close = useMutation({
    mutationFn: () => api<TrustCase>(`/me/appeals/${c.id}/close`, { method: 'POST' }),
    onSuccess: () => {
      setClosing(false);
      void qc.invalidateQueries({ queryKey: trustKeys.mine });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (body && !send.isPending) send.mutate(body);
  };

  return (
    <section aria-labelledby="appeal-title" className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onBack} aria-label={t('app.back')} className="inline-flex size-10 items-center justify-center rounded-lg text-muted hover:bg-surface-hover">
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <div className="min-w-48 flex-1">
          <h3 id="appeal-title" className="flex items-center gap-2 title-2">
            <span className="truncate">{pick(i18n.language, c.service.nameUk, c.service.nameEn)}</span>
            <Badge tone={open ? 'navy' : 'neutral'}>{open ? t('trust.status.OPEN') : t('trust.status.CLOSED')}</Badge>
          </h3>
          <p className="caption-5 text-muted">{t('trust.alias', { alias: c.alias })}</p>
        </div>
        {open && (
          <Button variant="secondary" size="sm" className="ml-auto" onClick={() => setClosing(true)}>
            {t('trust.close')}
          </Button>
        )}
      </header>

      <p className="flex items-start gap-2 rounded-xl bg-navy px-4 py-3 caption-4 text-white">
        <LockKey size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
        {t('trust.chatNote')}
      </p>

      <ul className="flex min-h-48 flex-col gap-3" aria-live="polite" aria-busy={messages.isPending || undefined}>
        {messages.isPending && <Skeleton className="h-16" />}
        {messages.isSuccess && list.length === 0 && <li className="body-6 text-muted">{t('trust.firstMessage')}</li>}
        {list.map((m) => (
          <AppealBubble key={m.id} m={m} pseudonymId={c.pseudonymId} />
        ))}
        <li ref={bottom} aria-hidden="true" />
      </ul>
      {messages.isError && <InlineError>{t('app.error')}</InlineError>}

      {open ? (
        <form onSubmit={submit} className="flex items-end gap-2">
          <TextArea
            aria-label={t('trust.messageLabel')}
            value={text}
            maxLength={MAX_TEXT}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) submit(e);
            }}
            className="flex-1"
          />
          <Button type="submit" aria-label={t('message.send')} icon={<PaperPlaneRight size={18} aria-hidden="true" />} loading={send.isPending} disabled={!text.trim()}>
            <span className="hidden sm:inline">{t('message.send')}</span>
          </Button>
        </form>
      ) : (
        <p className="rounded-xl bg-surface-2 px-4 py-3 caption-4 text-muted">
          {t('trust.closedNote', { when: c.closedAt ? formatDateTime(c.closedAt, i18n.language) : '' })}
        </p>
      )}
      {send.isError && <InlineError>{t('trust.sendFailed')}</InlineError>}

      <Dialog
        open={closing}
        onClose={() => setClosing(false)}
        title={t('trust.closeTitle')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setClosing(false)}>
              {t('app.cancel')}
            </Button>
            <Button variant="danger" loading={close.isPending} onClick={() => close.mutate()}>
              {t('trust.close')}
            </Button>
          </>
        }
      >
        <p className="body-6">{t('trust.closeHint')}</p>
      </Dialog>
    </section>
  );
}

/** «Анонімне звернення»: Ombudsman, Psychological Service, Military Registration. */
export function TrustPanel() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const services = useTrustServices();
  const mine = useMyAppeals();
  const [openId, setOpenId] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: (orgUnitId: string) => api<TrustCase>(`/trust-services/${orgUnitId}/appeals`, { method: 'POST' }),
    onSuccess: (c) => {
      qc.setQueryData<TrustCase[]>(trustKeys.mine, (l) => [c, ...(l ?? [])]);
      setOpenId(c.id);
    },
  });

  const current = mine.data?.find((c) => c.id === openId);
  if (current) return <AppealChat c={current} onBack={() => setOpenId(null)} />;

  const openCount = mine.data?.filter((c) => c.status === 'OPEN').length ?? 0;
  const atLimit = openCount >= MAX_OPEN_APPEALS;
  const startError = start.isError ? (statusOf(start.error) === 409 ? t('trust.unavailable') : t('app.error')) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-3 rounded-xl bg-surface px-4 py-3 ring-1 ring-line">
        <ShieldCheck size={22} aria-hidden="true" className="mt-0.5 shrink-0 text-primary" />
        <div className="flex flex-col gap-1">
          <p className="title-4">{t('trust.howTitle')}</p>
          <p className="body-6 text-muted">{t('trust.how')}</p>
        </div>
      </div>

      <section aria-labelledby="trust-services" className="flex flex-col gap-3">
        <h3 id="trust-services" className="title-3">
          {t('trust.services')}
        </h3>
        {services.isPending && <Skeleton className="h-16" />}
        {services.isError && <InlineError>{t('app.error')}</InlineError>}
        {services.data && !services.data.enabled && <p className="body-6 text-muted">{t('trust.disabled')}</p>}
        {services.data?.enabled && services.data.services.length === 0 && <p className="body-6 text-muted">{t('trust.noServices')}</p>}
        <ul className="grid gap-3 sm:grid-cols-2">
          {services.data?.enabled &&
            services.data.services.map((s) => (
              <li key={s.id} className="flex flex-col gap-3 rounded-xl bg-surface p-4 ring-1 ring-line">
                <p className="title-4">{pick(i18n.language, s.nameUk, s.nameEn)}</p>
                <Button size="sm" loading={start.isPending && start.variables === s.id} disabled={start.isPending || atLimit} onClick={() => start.mutate(s.id)}>
                  {t('trust.start')}
                </Button>
              </li>
            ))}
        </ul>
        {atLimit && <p className="caption-4 text-muted">{t('trust.tooMany', { n: MAX_OPEN_APPEALS })}</p>}
        {startError && <InlineError>{startError}</InlineError>}
      </section>

      <section aria-labelledby="trust-mine" className="flex flex-col gap-3">
        <h3 id="trust-mine" className="title-3">
          {t('trust.mine')}
        </h3>
        {mine.isPending && <Skeleton className="h-14" />}
        {mine.isSuccess && mine.data.length === 0 && <EmptyState icon={<UserCircleDashed size={28} />} title={t('trust.noAppeals')} />}
        <ul className="flex flex-col gap-2">
          {mine.data?.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setOpenId(c.id)}
                className="flex w-full items-center gap-3 rounded-xl bg-surface px-4 py-3 text-left ring-1 ring-line transition-colors duration-300 ease-pulse hover:bg-surface-hover"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate title-4">{pick(i18n.language, c.service.nameUk, c.service.nameEn)}</span>
                  <span className="caption-5 text-muted">
                    {t('trust.alias', { alias: c.alias })} · {formatDateTime(c.createdAt, i18n.language)}
                  </span>
                </span>
                <Badge tone={c.status === 'OPEN' ? 'navy' : 'neutral'}>{t(`trust.status.${c.status}`)}</Badge>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
