import { ArrowDown, ArrowUp, Plus, Trash } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { keys } from '../../api/queries';
import type { ApprovalRoute, Signature, UserCard } from '../../api/types';
import { Badge, Button, Dialog, Field, InlineError, Input, TextArea, Toggle, formatDateTime } from '../../components/ui';
import { pick } from '../../i18n';
import { useMe } from '../../session/session';
import { PeopleSearch } from '../chat/NewChatDialog';
import { SignDialog } from '../signatures/SignDialog';

const statusTone = (s: string) => (s === 'APPROVED' ? 'success' : s === 'REJECTED' ? 'danger' : s === 'PENDING' ? 'navy' : 'neutral');

export function useRoutes(fileId: string) {
  return useQuery({ queryKey: keys.routes(fileId), queryFn: () => api<ApprovalRoute[]>(`/files/${fileId}/approval-routes`) });
}

/** Decision controls for the approver whose turn it is. Approving a step that needs it requires the approver's own signature. */
export function DecisionBox({ route, onDone }: { route: ApprovalRoute; onDone?: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const step = route.steps.find((s) => s.id === route.currentStepId);
  const [comment, setComment] = useState('');
  const [signOpen, setSignOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (body: { decision: 'APPROVE' | 'REJECT'; comment?: string; signatureId?: string }) =>
      api(`/files/${route.fileId}/approval-routes/${route.id}/steps/${step!.id}/decision`, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.routes(route.fileId) });
      void qc.invalidateQueries({ queryKey: keys.approvals });
      void qc.invalidateQueries({ queryKey: keys.verification(route.fileId) });
      onDone?.();
    },
    onError: (e) => setError(e instanceof ApiError && e.status === 409 ? e.message : t('app.error')),
  });
  if (!step || step.approverId !== me.userId || route.status !== 'PENDING') return null;

  const c = comment.trim();
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-primary/40 bg-surface-2 p-3">
      {error && <InlineError>{error}</InlineError>}
      <Field label={t('approvals.comment')}>{(id) => <TextArea id={id} rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
      <div className="flex flex-wrap gap-2">
        {step.requireSignature ? (
          <Button variant="accent" onClick={() => setSignOpen(true)} loading={decide.isPending}>
            {t('approvals.approveSign')}
          </Button>
        ) : (
          <Button variant="primary" loading={decide.isPending} onClick={() => decide.mutate({ decision: 'APPROVE', ...(c ? { comment: c } : {}) })}>
            {t('approvals.approve')}
          </Button>
        )}
        <Button
          variant="danger"
          disabled={!c}
          title={c ? undefined : t('approvals.commentRequired')}
          onClick={() => decide.mutate({ decision: 'REJECT', comment: c })}
        >
          {t('approvals.reject')}
        </Button>
      </div>
      {!c && <p className="caption-5 text-muted">{t('approvals.commentRequired')}</p>}
      <SignDialog
        fileId={route.fileId}
        open={signOpen}
        onClose={() => setSignOpen(false)}
        onSigned={(s: Signature) => {
          setSignOpen(false);
          decide.mutate({ decision: 'APPROVE', signatureId: s.id, ...(c ? { comment: c } : {}) });
        }}
      />
    </div>
  );
}

export function RouteView({ route }: { route: ApprovalRoute }) {
  const { t, i18n } = useTranslation();
  return (
    <article className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
      <header className="flex items-center justify-between gap-2">
        <h4 className="title-4">{route.title}</h4>
        <Badge tone={statusTone(route.status)}>{t(`approvals.status.${route.status}`, { defaultValue: route.status })}</Badge>
      </header>
      <p className="caption-5 text-muted">{t('approvals.from', { name: route.createdByName })}</p>
      <ol className="flex flex-col gap-2">
        {route.steps.map((s) => (
          <li key={s.id} className="flex flex-col gap-0.5 border-l-2 pl-3" style={{ borderColor: s.id === route.currentStepId ? 'var(--puet-terracotta-accent)' : 'var(--pulse-border)' }}>
            <span className="flex items-center justify-between gap-2 body-6">
              <span>
                {s.position}. {s.approverName}
              </span>
              <Badge tone={statusTone(s.status)}>{t(`approvals.status.${s.status}`, { defaultValue: s.status })}</Badge>
            </span>
            {s.requireSignature && <span className="caption-5 text-muted">{t('approvals.requireSignature')}</span>}
            {s.comment && <span className="caption-5 text-ink">«{s.comment}»</span>}
            {s.decidedAt && <span className="caption-5 text-muted">{formatDateTime(s.decidedAt, i18n.language)}</span>}
          </li>
        ))}
      </ol>
      <DecisionBox route={route} />
    </article>
  );
}

/** Create a route: approvers in order (e.g. Head of Department → Institute Director). */
export function NewRouteDialog({ fileId, open, onClose }: { fileId: string; open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const [title, setTitle] = useState('');
  const [steps, setSteps] = useState<{ card: UserCard; requireSignature: boolean }[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api(`/files/${fileId}/approval-routes`, {
        method: 'POST',
        body: { title: title.trim(), steps: steps.map((s) => ({ approverId: s.card.id, requireSignature: s.requireSignature })) },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.routes(fileId) });
      setTitle('');
      setSteps([]);
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError && (e.status === 403 || e.status === 409 || e.status === 400) ? e.message : t('app.error')),
  });
  const move = (i: number, d: -1 | 1) =>
    setSteps((list) => {
      const n = [...list];
      const j = i + d;
      if (j < 0 || j >= n.length) return list;
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('approvals.start')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button variant="accent" disabled={!title.trim() || steps.length === 0} loading={create.isPending} onClick={() => create.mutate()}>
            {t('approvals.start')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <InlineError>{error}</InlineError>}
        <Field label={t('approvals.routeTitle')}>{(id) => <Input id={id} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <div className="flex flex-col gap-2">
          <p className="title-4">{t('approvals.steps')}</p>
          <ol className="flex flex-col gap-2">
            {steps.map((s, i) => (
              <li key={s.card.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2">
                <span className="flex-1 body-5">
                  {i + 1}. {pick(i18n.language, s.card.fullNameUk, s.card.fullNameEn)}
                </span>
                <Toggle
                  checked={s.requireSignature}
                  label={t('approvals.requireSignature')}
                  onChange={(v) => setSteps((l) => l.map((x, k) => (k === i ? { ...x, requireSignature: v } : x)))}
                />
                <Button size="sm" variant="ghost" aria-label="↑" onClick={() => move(i, -1)} icon={<ArrowUp size={16} />} />
                <Button size="sm" variant="ghost" aria-label="↓" onClick={() => move(i, 1)} icon={<ArrowDown size={16} />} />
                <Button size="sm" variant="ghost" aria-label={t('app.delete')} onClick={() => setSteps((l) => l.filter((_, k) => k !== i))} icon={<Trash size={16} />} />
              </li>
            ))}
          </ol>
          {adding ? (
            <PeopleSearch
              exclude={[me.userId, ...steps.map((s) => s.card.id)]}
              onPick={(c) => {
                setSteps((l) => [...l, { card: c, requireSignature: true }]);
                setAdding(false);
              }}
            />
          ) : (
            steps.length < 10 && (
              <Button variant="secondary" icon={<Plus size={18} />} onClick={() => setAdding(true)}>
                {t('approvals.addStep')}
              </Button>
            )
          )}
        </div>
      </div>
    </Dialog>
  );
}
