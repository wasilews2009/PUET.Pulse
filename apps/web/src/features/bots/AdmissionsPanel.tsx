import { PaperPlaneRight } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { keys, useAdmissionsKb, useBotMessages } from '../../api/queries';
import type { BotMessage } from '../../api/types';
import { Badge, Button, cx, Field, formatDateTime, formatTime, InlineError, Input, Skeleton, TextArea, Toggle } from '../../components/ui';
import { statusOf } from './bot-meta';

const MAX_RULES = 1_000_000;

function Bubble({ m }: { m: BotMessage }) {
  const { t, i18n } = useTranslation();
  const user = m.direction === 'USER';
  const card = m.card?.kind === 'answer' ? m.card : null;
  return (
    <li className={cx('flex', user ? 'justify-end' : 'justify-start')}>
      <div className={cx('flex max-w-[85%] flex-col gap-2 rounded-2xl px-4 py-3 shadow-sm', user ? 'bg-primary text-on-primary' : 'bg-surface ring-1 ring-line')}>
        {card && (
          <span>
            <Badge tone={card.mode === 'none' ? 'neutral' : card.mode === 'llm' ? 'accent' : 'navy'}>{t(`bots.admissions.modes.${card.mode}`)}</Badge>
          </span>
        )}
        {/* Plain text only: answers are never rendered as HTML or Markdown. */}
        <p className="body-6 whitespace-pre-wrap break-words">{m.body}</p>
        {card && card.sources.length > 0 && (
          <p className="caption-5 text-muted">
            {t('bots.admissions.sources', {
              list: card.sources.map((s) => s.heading ?? t('bots.admissions.fragment', { n: s.ordinal + 1 })).join('; '),
            })}
          </p>
        )}
        <time dateTime={m.createdAt} className={cx('self-end caption-5', user ? 'text-on-primary/80' : 'text-muted')}>
          {formatTime(m.createdAt, i18n.language)}
        </time>
      </div>
    </li>
  );
}

function KnowledgeBase() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const kb = useAdmissionsKb();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [activate, setActivate] = useState(true);
  const [fileError, setFileError] = useState(false);
  const [done, setDone] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.admissionsKb });
  const upload = useMutation({
    mutationFn: () => api('/bots/admissions/kb', { method: 'POST', body: { title: title.trim(), text, activate } }),
    onSuccess: () => {
      setTitle('');
      setText('');
      setDone(true);
      refresh();
    },
  });
  const makeActive = useMutation({ mutationFn: (id: string) => api(`/bots/admissions/kb/${id}/activate`, { method: 'POST' }), onSettled: refresh });
  if (!kb.data) return null; // Only the Admissions Office manages the rules (403 for everyone else).

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    setFileError(false);
    if (!f) return;
    if (f.size > MAX_RULES || !/\.(txt|md)$/i.test(f.name)) {
      setFileError(true);
      return;
    }
    setText(await f.text());
    if (!title.trim()) setTitle(f.name.replace(/\.(txt|md)$/i, '').slice(0, 200));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDone(false);
    upload.mutate();
  };
  const valid = title.trim().length >= 3 && text.length >= 100 && text.length <= MAX_RULES;

  return (
    <section aria-labelledby="kb-title" className="flex flex-col gap-4 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
      <div>
        <h2 id="kb-title" className="heading-6">
          {t('bots.admissions.kb')}
        </h2>
        <p className="body-6 text-muted">{t('bots.admissions.kbHint')}</p>
      </div>
      {kb.data.length === 0 && <p className="body-6 text-danger">{t('bots.admissions.kbEmpty')}</p>}
      <ul className="flex flex-col gap-2">
        {kb.data.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3 py-2">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate title-4">{d.title}</span>
              <span className="caption-5 text-muted">
                {formatDateTime(d.createdAt, i18n.language)} · {t('bots.admissions.kbChunks', { n: d.chunks })}
              </span>
            </span>
            {d.active ? (
              <Badge tone="success">{t('bots.admissions.kbActive')}</Badge>
            ) : (
              <Button size="sm" variant="secondary" loading={makeActive.isPending && makeActive.variables === d.id} onClick={() => makeActive.mutate(d.id)}>
                {t('bots.admissions.kbMakeActive')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t('bots.admissions.kbTitle')}>{(id) => <Input id={id} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label={t('bots.admissions.kbText')} error={fileError ? t('app.error') : undefined}>
          {(id, describedBy) => <TextArea id={id} rows={6} value={text} aria-describedby={describedBy} onChange={(e) => setText(e.target.value)} />}
        </Field>
        <Field label={t('bots.admissions.kbFile')}>{(id) => <input id={id} type="file" accept=".txt,.md,text/plain,text/markdown" onChange={(e) => void onFile(e)} className="caption-5" />}</Field>
        <Toggle checked={activate} onChange={setActivate} label={t('bots.admissions.kbActivate')} />
        {upload.isError && <InlineError>{t('app.error')}</InlineError>}
        {done && (
          <p role="status" className="body-6 text-success">
            {t('bots.admissions.kbUploaded')}
          </p>
        )}
        <div>
          <Button type="submit" disabled={!valid} loading={upload.isPending}>
            {t('bots.admissions.kbUpload')}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** «AI-консультант приймальної комісії»: questions about admission, answered from the current rules. */
export function AdmissionsPanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const msgs = useBotMessages('admissions');
  const [q, setQ] = useState('');
  const end = useRef<HTMLFormElement>(null);
  const seen = useRef<number | null>(null);
  const ask = useMutation({
    mutationFn: (question: string) => api('/bots/admissions/ask', { method: 'POST', body: { question } }),
    onSuccess: () => {
      setQ('');
      void qc.invalidateQueries({ queryKey: keys.botMessages('admissions') });
    },
  });
  const count = msgs.data?.length ?? 0;
  // Keep the question box in view when a new answer arrives (not on the first load).
  useEffect(() => {
    if (seen.current !== null && count > seen.current) end.current?.scrollIntoView?.({ block: 'nearest' });
    if (msgs.isSuccess) seen.current = count;
  }, [count, msgs.isSuccess]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const question = q.trim();
    if (question.length >= 3 && !ask.isPending) ask.mutate(question);
  };

  return (
    <div className="flex flex-col gap-6">
      <section aria-label={t('bots.names.admissions')} className="flex flex-col gap-3 rounded-2xl bg-canvas">
        <p className="caption-5 text-muted">{t('bots.admissions.hint')}</p>
        {msgs.isPending && <Skeleton className="h-24" />}
        {msgs.isError && <InlineError>{t('app.error')}</InlineError>}
        {msgs.isSuccess && count === 0 && <p className="body-6 text-muted">{t('bots.admissions.empty')}</p>}
        <ol className="flex flex-col gap-3" aria-live="polite">
          {msgs.data?.map((m) => (
            <Bubble key={m.id} m={m} />
          ))}
        </ol>
        {ask.isError && <InlineError>{statusOf(ask.error) === 429 ? t('bots.admissions.tooMany') : t('app.error')}</InlineError>}
        <form ref={end} onSubmit={submit} className="flex items-end gap-2">
          <label htmlFor="admissions-q" className="sr-only">
            {t('bots.admissions.placeholder')}
          </label>
          <TextArea
            id="admissions-q"
            rows={2}
            maxLength={500}
            value={q}
            placeholder={t('bots.admissions.placeholder')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) submit(e);
            }}
          />
          <Button type="submit" variant="accent" icon={<PaperPlaneRight size={18} aria-hidden="true" />} disabled={q.trim().length < 3} loading={ask.isPending}>
            {t('bots.admissions.ask')}
          </Button>
        </form>
      </section>
      <KnowledgeBase />
    </div>
  );
}
