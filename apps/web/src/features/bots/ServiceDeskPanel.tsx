import { Wrench } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { keys, useMyTickets, useTicket, useTicketQueue } from '../../api/queries';
import type { Ticket } from '../../api/types';
import { Badge, Button, cx, Dialog, EmptyState, Field, formatDateTime, InlineError, Input, Select, Skeleton, TextArea } from '../../components/ui';
import { pick } from '../../i18n';
import { useMe } from '../../session/session';
import { BotFeed } from './BotFeed';
import { statusOf } from './bot-meta';

const CATEGORIES = ['IT', 'FACILITIES', 'DORMITORY'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const statusTone = (s: string) => (s === 'RESOLVED' ? 'success' : s === 'REJECTED' ? 'danger' : s === 'CLOSED' ? 'neutral' : 'navy') as 'success' | 'danger' | 'neutral' | 'navy';

function NewTicket({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('IT');
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>('NORMAL');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [done, setDone] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      api('/service-desk/tickets', {
        method: 'POST',
        body: { category, priority, title: title.trim(), description: description.trim(), ...(category !== 'DORMITORY' ? { location: location.trim() } : {}) },
      }),
    onSuccess: () => {
      setTitle('');
      setDescription('');
      setLocation('');
      setDone(true);
      onCreated();
    },
  });
  const valid = title.trim().length >= 3 && description.trim().length > 0 && (category === 'DORMITORY' || location.trim().length > 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDone(false);
    if (valid) create.mutate();
  };
  return (
    <section aria-labelledby="desk-new" className="flex flex-col gap-4 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
      <h2 id="desk-new" className="heading-6">
        {t('bots.desk.new')}
      </h2>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('bots.desk.category')}>
            {(id) => (
              <Select id={id} value={category} onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number])}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`bots.desk.categories.${c}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('bots.desk.priority')}>
            {(id) => (
              <Select id={id} value={priority} onChange={(e) => setPriority(e.target.value as (typeof PRIORITIES)[number])}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t(`bots.desk.priorities.${p}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label={t('bots.desk.title')}>{(id) => <Input id={id} required minLength={3} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label={t('bots.desk.description')}>
          {(id) => <TextArea id={id} required rows={3} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        {category === 'DORMITORY' ? (
          <p className="caption-5 text-muted">{t('bots.desk.dormNote')}</p>
        ) : (
          <Field label={t('bots.desk.location')}>{(id) => <Input id={id} required maxLength={120} value={location} onChange={(e) => setLocation(e.target.value)} />}</Field>
        )}
        {create.isError && <InlineError>{t('app.error')}</InlineError>}
        {done && (
          <p role="status" className="body-6 text-success">
            {t('bots.desk.created')}
          </p>
        )}
        <div>
          <Button type="submit" variant="accent" disabled={!valid} loading={create.isPending}>
            {t('bots.desk.create')}
          </Button>
        </div>
      </form>
    </section>
  );
}

function TicketRow({ ticket, onOpen }: { ticket: Ticket; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-wrap items-center gap-3 rounded-2xl bg-surface p-4 text-left shadow-sm ring-1 ring-line transition-colors duration-300 ease-pulse hover:bg-surface-hover"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate title-4">
            {t('bots.desk.number', { n: ticket.number })}: {ticket.title}
          </span>
          <span className="truncate caption-5 text-muted">
            {[t(`bots.desk.categoryShort.${ticket.category}`), ticket.location, ticket.dormitory ? t('bots.desk.dorm', { n: ticket.dormitory }) : null, formatDateTime(ticket.createdAt, i18n.language)]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        {ticket.priority === 'URGENT' || ticket.priority === 'HIGH' ? <Badge tone="accent">{t(`bots.desk.priorities.${ticket.priority}`)}</Badge> : null}
        <Badge tone={statusTone(ticket.status)}>{t(`bots.desk.status.${ticket.status}`)}</Badge>
      </button>
    </li>
  );
}

function TicketDialog({ id, asHandler, onClose }: { id: string | null; asHandler: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const ticket = useTicket(id);
  const [comment, setComment] = useState('');
  const [needComment, setNeedComment] = useState(false);
  const after = (data: unknown) => {
    qc.setQueryData(keys.ticket(id!), data);
    void qc.invalidateQueries({ queryKey: ['bots', 'tickets'] });
    setComment('');
    setNeedComment(false);
  };
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) => api<Ticket>(`/service-desk/tickets/${id}/${path}`, { method: 'POST', body }),
    onSuccess: after,
  });
  const withComment = (body: Record<string, unknown>) => (comment.trim() ? { ...body, comment: comment.trim() } : body);
  const requireComment = (fn: () => void) => () => {
    if (!comment.trim()) setNeedComment(true);
    else fn();
  };
  const tk = ticket.data;
  const open = tk && tk.status !== 'CLOSED' && tk.status !== 'REJECTED';
  const mine = tk?.requesterId === me.userId;

  return (
    <Dialog open={!!id} onClose={onClose} title={tk ? t('bots.desk.number', { n: tk.number }) : t('app.loading')} wide>
      {ticket.isPending && <Skeleton className="h-40" />}
      {ticket.isError && <InlineError>{t('app.error')}</InlineError>}
      {tk && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 flex-1 title-2">{tk.title}</h3>
            <Badge tone={statusTone(tk.status)}>{t(`bots.desk.status.${tk.status}`)}</Badge>
          </div>
          <p className="body-6 whitespace-pre-wrap">{tk.description}</p>
          <dl className="grid gap-x-4 gap-y-1 caption-5 sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted">{t('bots.desk.category')}</dt>
            <dd>{tk.unit ? pick(i18n.language, tk.unit.nameUk, tk.unit.nameEn) : t(`bots.desk.categoryShort.${tk.category}`)}</dd>
            {tk.location && (
              <>
                <dt className="text-muted">{t('bots.desk.location')}</dt>
                <dd>{tk.location}</dd>
              </>
            )}
            {tk.dormitory && (
              <>
                <dt className="text-muted">{t('bots.desk.dorm', { n: tk.dormitory })}</dt>
                <dd>{tk.room ? t('bots.desk.room', { room: tk.room }) : t('bots.desk.roomHidden')}</dd>
              </>
            )}
            <dt className="text-muted">{t('bots.desk.requester')}</dt>
            <dd>{tk.requesterName ?? '·'}</dd>
            {tk.assigneeName && (
              <>
                <dt className="text-muted">{t('bots.desk.assignee')}</dt>
                <dd>{tk.assigneeName}</dd>
              </>
            )}
          </dl>
          <section aria-labelledby="ticket-history" className="flex flex-col gap-2">
            <h4 id="ticket-history" className="title-4">
              {t('bots.desk.history')}
            </h4>
            <ol className="flex flex-col gap-2 border-l-2 border-line pl-4">
              {tk.events?.map((e) => (
                <li key={e.id} className="flex flex-col gap-0.5">
                  <span className="caption-4">
                    {t(`bots.desk.eventKinds.${e.kind}`, { defaultValue: e.kind })}
                    {e.status ? `: ${t(`bots.desk.status.${e.status}`, { defaultValue: e.status })}` : ''}
                    <span className="text-muted">
                      {' · '}
                      {e.actorName ?? '·'} · {formatDateTime(e.createdAt, i18n.language)}
                    </span>
                  </span>
                  {e.comment && <span className="body-6 whitespace-pre-wrap">{e.comment}</span>}
                </li>
              ))}
            </ol>
          </section>
          {open && (
            <Field label={t('bots.desk.comment')} error={needComment ? t('bots.desk.commentRequired') : undefined}>
              {(fid, describedBy) => <TextArea id={fid} rows={2} maxLength={2000} value={comment} aria-describedby={describedBy} onChange={(e) => setComment(e.target.value)} />}
            </Field>
          )}
          {act.isError && <InlineError>{statusOf(act.error) === 409 ? t('bots.desk.impossible') : t('app.error')}</InlineError>}
          {open && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={!comment.trim()} loading={act.isPending} onClick={() => act.mutate({ path: 'comments', body: { comment: comment.trim() } })}>
                {t('bots.desk.send')}
              </Button>
              {asHandler && (
                <>
                  {tk.status === 'NEW' && (
                    <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ path: 'handle', body: withComment({ assignToMe: true, status: 'IN_PROGRESS' }) })}>
                      {t('bots.desk.assignToMe')}
                    </Button>
                  )}
                  {tk.category === 'DORMITORY' && (
                    <Button variant="secondary" loading={act.isPending} onClick={() => act.mutate({ path: 'handle', body: withComment({ forwardTo: 'FACILITIES' }) })}>
                      {t('bots.desk.forward')}
                    </Button>
                  )}
                  {(tk.status === 'NEW' || tk.status === 'IN_PROGRESS') && (
                    <>
                      <Button variant="accent" loading={act.isPending} onClick={() => act.mutate({ path: 'handle', body: withComment({ status: 'RESOLVED' }) })}>
                        {t('bots.desk.resolve')}
                      </Button>
                      <Button variant="danger" loading={act.isPending} onClick={requireComment(() => act.mutate({ path: 'handle', body: withComment({ status: 'REJECTED' }) }))}>
                        {t('bots.desk.reject')}
                      </Button>
                    </>
                  )}
                </>
              )}
              {mine && tk.status === 'RESOLVED' && (
                <>
                  <Button variant="accent" loading={act.isPending} onClick={() => act.mutate({ path: 'requester', body: withComment({ action: 'CONFIRM' }) })}>
                    {t('bots.desk.confirm')}
                  </Button>
                  <Button variant="danger" loading={act.isPending} onClick={requireComment(() => act.mutate({ path: 'requester', body: withComment({ action: 'REOPEN' }) }))}>
                    {t('bots.desk.reopen')}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** «Сервіс-деск АГР та ІТ»: one's own requests, and the queue for those who handle them. */
export function ServiceDeskPanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const mine = useMyTickets();
  const [queueTab, setQueueTab] = useState<'open' | 'closed'>('open');
  const queue = useTicketQueue(queueTab);
  const [openId, setOpenId] = useState<{ id: string; asHandler: boolean } | null>(null);
  const handler = queue.data !== null && queue.data !== undefined;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bots', 'tickets'] });
    void qc.invalidateQueries({ queryKey: keys.botMessages('service-desk') });
  };

  return (
    <div className="flex flex-col gap-8">
      {handler && (
        <section aria-labelledby="desk-queue" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="desk-queue" className="heading-6">
              {t('bots.desk.queue')}
            </h2>
            <div role="tablist" className="inline-flex rounded-lg border border-line bg-surface p-0.5">
              {(['open', 'closed'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={queueTab === tab}
                  onClick={() => setQueueTab(tab)}
                  className={cx('rounded-md px-3 py-1 button-sm transition-colors duration-300 ease-pulse', queueTab === tab ? 'bg-primary text-on-primary' : 'text-muted hover:text-ink')}
                >
                  {t(`bots.desk.${tab}`)}
                </button>
              ))}
            </div>
          </div>
          {queue.data?.length === 0 && <p className="body-6 text-muted">{t('bots.desk.queueEmpty')}</p>}
          <ul className="flex flex-col gap-2">
            {queue.data?.map((tk) => (
              <TicketRow key={tk.id} ticket={tk} onOpen={() => setOpenId({ id: tk.id, asHandler: true })} />
            ))}
          </ul>
        </section>
      )}

      <NewTicket onCreated={refresh} />

      <section aria-labelledby="desk-mine" className="flex flex-col gap-3">
        <h2 id="desk-mine" className="heading-6">
          {t('bots.desk.mine')}
        </h2>
        {mine.isPending && <Skeleton className="h-16" />}
        {mine.isError && <InlineError>{t('app.error')}</InlineError>}
        {mine.data?.length === 0 && <EmptyState icon={<Wrench size={28} />} title={t('bots.desk.empty')} />}
        <ul className="flex flex-col gap-2">
          {mine.data?.map((tk) => (
            <TicketRow key={tk.id} ticket={tk} onOpen={() => setOpenId({ id: tk.id, asHandler: false })} />
          ))}
        </ul>
      </section>

      <BotFeed bot="service-desk" onOpenTicket={(id) => setOpenId({ id, asHandler: handler })} />
      <TicketDialog id={openId?.id ?? null} asHandler={openId?.asHandler ?? false} onClose={() => setOpenId(null)} />
    </div>
  );
}
