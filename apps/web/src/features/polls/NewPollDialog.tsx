import { Plus, X } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { keys } from '../../api/queries';
import type { Channel, Poll } from '../../api/types';
import { Button, Dialog, Field, IconButton, InlineError, Input, Select, TextArea, Toggle } from '../../components/ui';
import { isModerator } from '../chat/channel-utils';

const MAX_OPTIONS = 12;
const DEADLINES = { none: 0, '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 } as const;
type Deadline = keyof typeof DEADLINES;

/** Collegial bodies (Вчена рада, Ректорат, НМР): their moderators may hold formal votes. */
export const canHoldFormalVote = (c: Channel) => c.type === 'GOVERNANCE' && isModerator(c);

export function NewPollDialog({ channel, open, onClose }: { channel: Channel; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const formalAllowed = canHoldFormalVote(channel);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [mode, setMode] = useState<'OPEN' | 'SECRET'>(formalAllowed ? 'SECRET' : 'OPEN');
  const [multiple, setMultiple] = useState(false);
  const [formal, setFormal] = useState(formalAllowed);
  const [quorum, setQuorum] = useState('');
  const [deadline, setDeadline] = useState<Deadline>('none');
  const [error, setError] = useState<string | null>(null);

  const cleaned = options.map((o) => o.trim()).filter(Boolean);
  const distinct = new Set(cleaned.map((o) => o.toLowerCase())).size === cleaned.length;
  const valid = question.trim().length > 0 && (formal || (cleaned.length >= 2 && distinct));

  const create = useMutation({
    mutationFn: () =>
      api<Poll>(`/channels/${channel.id}/polls`, {
        method: 'POST',
        body: {
          question: question.trim(),
          mode,
          formal,
          ...(formal ? (quorum ? { quorum: Number(quorum) } : {}) : { options: cleaned, multipleChoice: multiple }),
          ...(DEADLINES[deadline] ? { closesAt: new Date(Date.now() + DEADLINES[deadline]).toISOString() } : {}),
        },
      }),
    onSuccess: (p) => {
      qc.setQueryData(keys.poll(p.id), p);
      setQuestion('');
      setOptions(['', '']);
      setQuorum('');
      setError(null);
      onClose();
    },
    onError: () => setError(t('poll.createFailed')),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={formal ? t('poll.formalTitle') : t('poll.createTitle')}
      footer={
        <Button variant="accent" disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>
          {t('poll.start')}
        </Button>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) create.mutate();
        }}
      >
        {error && <InlineError>{error}</InlineError>}
        <Field label={t('poll.question')}>{(id) => <TextArea id={id} rows={2} maxLength={500} value={question} onChange={(e) => setQuestion(e.target.value)} />}</Field>

        {formalAllowed && <Toggle checked={formal} onChange={setFormal} label={t('poll.formal')} />}
        {formal ? (
          <>
            <p className="caption-5 text-muted">{t('poll.formalHint')}</p>
            <Field label={t('poll.quorum')} hint={t('poll.quorumHint')}>
              {(id, d) => <Input id={id} aria-describedby={d} type="number" min={1} inputMode="numeric" value={quorum} onChange={(e) => setQuorum(e.target.value.replace(/\D/g, '').slice(0, 4))} />}
            </Field>
          </>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 title-4">{t('poll.options')}</legend>
            {options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input aria-label={t('poll.option', { n: i + 1 })} placeholder={t('poll.option', { n: i + 1 })} maxLength={200} value={o} onChange={(e) => setOptions((all) => all.map((x, k) => (k === i ? e.target.value : x)))} />
                {options.length > 2 && (
                  <IconButton label={t('poll.removeOption', { n: i + 1 })} onClick={() => setOptions((all) => all.filter((_, k) => k !== i))}>
                    <X size={18} />
                  </IconButton>
                )}
              </div>
            ))}
            {options.length < MAX_OPTIONS && (
              <Button size="sm" variant="ghost" className="self-start" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setOptions((all) => [...all, ''])}>
                {t('poll.addOption')}
              </Button>
            )}
            {cleaned.length >= 2 && !distinct && <InlineError>{t('poll.needOptions')}</InlineError>}
            <Toggle checked={multiple} onChange={setMultiple} label={t('poll.multiple')} />
          </fieldset>
        )}

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 title-4">{t('poll.mode')}</legend>
          {(['OPEN', 'SECRET'] as const).map((m) => (
            <label key={m} className="flex items-center gap-2 body-6">
              <input type="radio" name="poll-mode" checked={mode === m} onChange={() => setMode(m)} className="accent-[var(--pulse-accent)]" />
              {m === 'OPEN' ? t('poll.modeOpen') : t('poll.modeSecret')}
            </label>
          ))}
        </fieldset>

        <Field label={t('poll.deadline')}>
          {(id) => (
            <Select id={id} value={deadline} onChange={(e) => setDeadline(e.target.value as Deadline)}>
              <option value="none">{t('poll.deadlineNone')}</option>
              <option value="1h">{t('poll.deadline1h')}</option>
              <option value="24h">{t('poll.deadline24h')}</option>
              <option value="7d">{t('poll.deadline7d')}</option>
            </Select>
          )}
        </Field>
      </form>
    </Dialog>
  );
}
