import { CheckCircle, FilePdf, LockSimple, Scales, ChartBar } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, API_BASE } from '../../api/client';
import { keys, useCard, usePoll } from '../../api/queries';
import type { Channel, Poll } from '../../api/types';
import { Badge, Button, InlineError, Skeleton, formatDateTime } from '../../components/ui';
import { pick } from '../../i18n';
import { useMe } from '../../session/session';
import { isModerator } from '../chat/channel-utils';

/** Formal votes carry answer codes; ordinary polls carry the author's labels. */
export function optionLabel(p: Pick<Poll, 'formal'>, label: string, t: (k: string) => string) {
  return p.formal ? t(`poll.answers.${label}`) : label;
}

function VoterName({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const card = useCard(id);
  return <>{card.data ? pick(i18n.language, card.data.fullNameUk, card.data.fullNameEn) : t('chats.hiddenUser')}</>;
}

/** A poll or formal vote inside the timeline: vote, live results, quorum, closing and protocol. */
export function PollCard({ pollId, channel }: { pollId: string; channel: Channel }) {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const q = usePoll(pollId);
  const [choice, setChoice] = useState<number[]>([]);
  const [showVoters, setShowVoters] = useState(false);

  const vote = useMutation({
    mutationFn: (options: number[]) => api<Poll>(`/polls/${pollId}/votes`, { method: 'POST', body: { options } }),
    onSuccess: (p) => qc.setQueryData(keys.poll(pollId), p),
    onError: () => void qc.invalidateQueries({ queryKey: keys.poll(pollId) }),
  });
  const close = useMutation({
    mutationFn: () => api<Poll>(`/polls/${pollId}/close`, { method: 'POST' }),
    onSuccess: (p) => qc.setQueryData(keys.poll(pollId), p),
  });

  if (q.isPending) return <Skeleton className="h-32 w-72" />;
  if (q.isError || !q.data) return <InlineError>{t('app.error')}</InlineError>;
  const p = q.data;
  const open = p.status === 'OPEN';
  const canVote = open && !p.me.voted && p.me.eligible && !channel.archived && channel.role !== 'READ_ONLY';
  const canClose = open && (p.createdById === me.userId || isModerator(channel)) && !channel.archived;
  const total = p.counts ? Math.max(1, p.multipleChoice ? p.participants : p.counts.reduce((a, b) => a + b, 0)) : 1;
  const name = p.formal ? 'pulse-vote' : 'pulse-poll';

  const toggle = (i: number) =>
    setChoice((c) => (p.multipleChoice ? (c.includes(i) ? c.filter((x) => x !== i) : [...c, i]) : [i]));

  return (
    <section aria-label={p.question} className="flex w-[min(28rem,100%)] flex-col gap-3 whitespace-normal">
      <header className="flex flex-wrap items-center gap-2">
        <Badge tone={p.formal ? 'navy' : 'neutral'}>
          {p.formal ? <Scales size={14} aria-hidden="true" /> : <ChartBar size={14} aria-hidden="true" />}
          {p.formal ? t('poll.badgeFormal') : t('poll.badgePoll')}
        </Badge>
        <span className="flex items-center gap-1 caption-4 opacity-80">
          {p.mode === 'SECRET' && <LockSimple size={12} aria-hidden="true" />}
          {[
            p.mode === 'SECRET' ? t('poll.secret') : t('poll.open'),
            open ? (p.closesAt ? t('poll.closesAt', { time: formatDateTime(p.closesAt, i18n.language) }) : null) : t('poll.closed'),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </header>
      <p className="body-4">{p.question}</p>

      {canVote ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">{p.question}</legend>
          {p.options.map((o, i) => (
            <label key={i} className="flex cursor-pointer items-center gap-2 rounded-lg border border-current/20 px-3 py-2 body-6 hover:bg-current/5">
              <input
                type={p.multipleChoice ? 'checkbox' : 'radio'}
                name={`${name}-${p.id}`}
                checked={choice.includes(i)}
                onChange={() => toggle(i)}
                className="accent-[var(--pulse-accent)]"
              />
              {optionLabel(p, o, t)}
            </label>
          ))}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="accent" disabled={choice.length === 0} loading={vote.isPending} onClick={() => vote.mutate(choice)}>
              {t('poll.vote')}
            </Button>
          </div>
          {vote.isError && <InlineError>{t('poll.failed')}</InlineError>}
        </fieldset>
      ) : p.counts ? (
        <ul className="flex flex-col gap-2">
          {p.options.map((o, i) => {
            const n = p.counts![i] ?? 0;
            const share = Math.round((n / total) * 100);
            const mine = p.me.options?.includes(i);
            return (
              <li key={i} className="flex flex-col gap-1">
                <span className="flex items-center justify-between gap-2 body-6">
                  <span className="flex items-center gap-1">
                    {mine && <CheckCircle size={16} weight="fill" aria-hidden="true" />}
                    {optionLabel(p, o, t)}
                  </span>
                  <span className="caption-4 opacity-80">
                    {t('poll.votes', { count: n })} · {share}%
                  </span>
                </span>
                <span aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-current/15">
                  <span className="block h-full origin-left rounded-full bg-accent transition-transform duration-500 ease-pulse" style={{ transform: `scaleX(${share / 100})` }} />
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="caption-5 opacity-80">{t('poll.hiddenUntilClose')}</p>
      )}

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 caption-4 opacity-90">
        <span>
          {t('poll.participants', { n: p.participants, total: p.eligibleCount })}
          {p.formal && p.quorum !== null ? ` · ${t('poll.quorumLine', { n: p.quorum })}` : ''}
        </span>
        {p.me.voted && <span className="font-semibold">{t('poll.voted')}</span>}
        {open && !p.me.eligible && <span>{t('poll.notEligible')}</span>}
        {p.formal && !open && (
          <Badge tone={p.adopted ? 'success' : 'danger'}>
            {p.quorumReached ? (p.adopted ? t('poll.adopted') : t('poll.rejected')) : `${t('poll.quorumMissing')} · ${t('poll.rejected')}`}
          </Badge>
        )}
      </footer>

      {p.voters && p.participants > 0 && (
        <div>
          <button type="button" className="caption-3 underline-offset-2 hover:underline" aria-expanded={showVoters} onClick={() => setShowVoters((v) => !v)}>
            {t('poll.voters')}
          </button>
          {showVoters && (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 caption-5">
              {p.options.map((o, i) =>
                p.voters![i]!.length ? (
                  <div key={i} className="contents">
                    <dt className="font-semibold">{optionLabel(p, o, t)}</dt>
                    <dd>
                      {p.voters![i]!.map((id, k) => (
                        <span key={id}>
                          {k > 0 && ', '}
                          <VoterName id={id} />
                        </span>
                      ))}
                    </dd>
                  </div>
                ) : null,
              )}
            </dl>
          )}
        </div>
      )}

      {(canClose || (p.formal && !open)) && (
        <div className="flex flex-wrap gap-2">
          {canClose && (
            <Button size="sm" variant="secondary" loading={close.isPending} onClick={() => close.mutate()}>
              {t('poll.close')}
            </Button>
          )}
          {p.formal && !open && (
            <a
              href={`${API_BASE}/polls/${p.id}/protocol.pdf?lang=${i18n.language === 'en' ? 'en' : 'uk'}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1 button-sm text-ink hover:bg-surface-hover"
            >
              <FilePdf size={18} aria-hidden="true" />
              {t('poll.protocol')}
            </a>
          )}
        </div>
      )}
    </section>
  );
}
