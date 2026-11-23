import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { keys, useDocRequests, useStudyPlan } from '../../api/queries';
import { Badge, Button, Field, formatDateTime, InlineError, Input, Select, Skeleton } from '../../components/ui';
import { BotFeed } from './BotFeed';
import { statusOf } from './bot-meta';

const TYPES = ['STUDY_CERTIFICATE', 'MILITARY_CERTIFICATE', 'INCOME_CERTIFICATE', 'ACADEMIC_TRANSCRIPT'] as const;
const OPEN = new Set(['REQUESTED', 'IN_PROGRESS', 'READY']);

/** «ЄДЕБО / Деканат»: certificate orders and the status of the individual study plan. */
export function DeaneryPanel() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const requests = useDocRequests();
  const plans = useStudyPlan();
  const [type, setType] = useState<(typeof TYPES)[number]>('STUDY_CERTIFICATE');
  const [copies, setCopies] = useState(1);
  const [purpose, setPurpose] = useState('');
  const [done, setDone] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.docRequests });
    void qc.invalidateQueries({ queryKey: keys.botMessages('deanery') });
  };
  const order = useMutation({
    mutationFn: () => api('/deanery/requests', { method: 'POST', body: { type, copies, ...(purpose.trim() ? { purpose: purpose.trim() } : {}) } }),
    onSuccess: () => {
      setPurpose('');
      setDone(true);
      refresh();
    },
  });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/deanery/requests/${id}/cancel`, { method: 'POST' }), onSettled: refresh });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDone(false);
    order.mutate();
  };

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="deanery-order" className="flex flex-col gap-4 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
        <h2 id="deanery-order" className="heading-6">
          {t('bots.deanery.order')}
        </h2>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label={t('bots.deanery.type')}>
            {(id) => (
              <Select id={id} value={type} onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}>
                {TYPES.map((x) => (
                  <option key={x} value={x}>
                    {t(`bots.docTypes.${x}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-[11rem_1fr]">
            <Field label={t('bots.deanery.copies')}>
              {(id) => <Input id={id} type="number" min={1} max={5} value={copies} onChange={(e) => setCopies(Math.min(5, Math.max(1, Number(e.target.value) || 1)))} />}
            </Field>
            <Field label={t('bots.deanery.purpose')}>
              {(id) => <Input id={id} maxLength={200} value={purpose} placeholder={t('bots.deanery.purposePlaceholder')} onChange={(e) => setPurpose(e.target.value)} />}
            </Field>
          </div>
          {order.isError && <InlineError>{statusOf(order.error) === 409 ? t('bots.deanery.conflict') : t('app.error')}</InlineError>}
          {done && (
            <p role="status" className="body-6 text-success">
              {t('bots.deanery.ordered')}
            </p>
          )}
          <div>
            <Button type="submit" variant="accent" loading={order.isPending}>
              {t('bots.deanery.submit')}
            </Button>
          </div>
        </form>
      </section>

      <section aria-labelledby="deanery-mine" className="flex flex-col gap-3">
        <h2 id="deanery-mine" className="heading-6">
          {t('bots.deanery.mine')}
        </h2>
        {requests.isPending && <Skeleton className="h-16" />}
        {requests.isError && <InlineError>{t('app.error')}</InlineError>}
        {requests.data?.length === 0 && <p className="body-6 text-muted">{t('bots.deanery.none')}</p>}
        <ul className="flex flex-col gap-2">
          {requests.data?.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="title-4">{t(`bots.docTypes.${r.type}`, { defaultValue: r.type })}</span>
                <span className="caption-5 text-muted">{formatDateTime(r.createdAt, i18n.language)}</span>
                {r.note && <span className="body-6 text-muted">{t('bots.deanery.note', { note: r.note })}</span>}
              </div>
              <Badge tone={r.status === 'READY' ? 'success' : r.status === 'REJECTED' ? 'danger' : OPEN.has(r.status) ? 'navy' : 'neutral'}>
                {t(`bots.docStatus.${r.status}`, { defaultValue: r.status })}
              </Badge>
              {r.status === 'REQUESTED' && (
                <Button size="sm" variant="secondary" loading={cancel.isPending && cancel.variables === r.id} onClick={() => cancel.mutate(r.id)}>
                  {t('bots.deanery.cancel')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="deanery-plan" className="flex flex-col gap-3">
        <h2 id="deanery-plan" className="heading-6">
          {t('bots.deanery.studyPlan')}
        </h2>
        {plans.isPending && <Skeleton className="h-16" />}
        {plans.data?.length === 0 && <p className="body-6 text-muted">{t('bots.deanery.noPlan')}</p>}
        <ul className="flex flex-col gap-2">
          {plans.data?.map((p) => (
            <li key={p.semester} className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="title-4">{t('bots.deanery.semester', { code: p.semester })}</span>
                {p.credits !== null && <span className="caption-5 text-muted">{t('bots.deanery.credits', { n: p.credits })}</span>}
                {p.note && <span className="body-6 text-muted">{t('bots.deanery.note', { note: p.note })}</span>}
              </div>
              <Badge tone={p.status === 'APPROVED' ? 'success' : p.status === 'NEEDS_CHANGES' ? 'accent' : 'neutral'}>{t(`bots.planStatus.${p.status}`, { defaultValue: p.status })}</Badge>
            </li>
          ))}
        </ul>
      </section>

      <BotFeed bot="deanery" />
    </div>
  );
}
