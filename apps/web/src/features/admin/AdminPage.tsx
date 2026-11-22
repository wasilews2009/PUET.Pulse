import { CheckCircle, LinkSimple, Plus, ShieldStar, Warning } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Route, Routes } from 'react-router';
import { api, ApiError } from '../../api/client';
import { useCard } from '../../api/queries';
import type { AbacPolicy, AuditEntry, Decision, PermissionMatrix, RoleAssignment, Structure, UserCard } from '../../api/types';
import { Badge, Button, cx, Dialog, EmptyState, Field, InlineError, Input, Select, Skeleton, TextArea, Toggle, formatDateTime } from '../../components/ui';
import { pick } from '../../i18n';
import { isAdmin, useMe } from '../../session/session';
import { PeopleSearch } from '../chat/NewChatDialog';

const ROLES = [
  'SUPER_ADMIN',
  'RECTORATE',
  'INSTITUTE_DIRECTOR',
  'DEPARTMENT_HEAD',
  'LECTURER',
  'ADMIN_STAFF',
  'TRUST_SERVICE_OFFICER',
  'CIVIL_PROTECTION_OFFICER',
  'FACILITIES_STAFF',
  'DORM_COMMANDANT',
  'STUDENT',
  'GROUP_LEADER',
  'GUEST',
];

function errorText(e: unknown, t: (k: string) => string) {
  if (e instanceof ApiError) {
    if (e.status === 403) return e.message.toLowerCase().includes('mfa') ? t('admin.mfaStepUp') : t('app.accessDenied');
    if (e.status === 400 || e.status === 409 || e.status === 422) return e.message;
  }
  return t('app.error');
}

function Panel({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="heading-6">{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left body-6">
        <thead>
          <tr className="border-b border-line">
            {head.map((h) => (
              <th key={h} scope="col" className="px-2 py-2 caption-3 whitespace-nowrap text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

function useStructure() {
  const me = useMe();
  return useQuery({ queryKey: ['admin', 'structure', me.tenantId], queryFn: () => api<Structure>(`/admin/tenants/${me.tenantId}/structure`) });
}

// ─────────────────────────── Structure ───────────────────────────

function AddNamedDialog({ kind, open, onClose }: { kind: 'institutes' | 'departments'; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const [v, setV] = useState({ code: '', nameUk: '', nameEn: '' });
  const save = useMutation({
    mutationFn: () => api(`/admin/tenants/${me.tenantId}/${kind}`, { method: 'POST', body: v }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'structure'] });
      setV({ code: '', nameUk: '', nameEn: '' });
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${t('admin.add')}: ${t(`admin.${kind}`)}`}
      footer={
        <Button disabled={!/^[A-Z0-9_]{2,64}$/.test(v.code) || !v.nameUk.trim() || !v.nameEn.trim()} loading={save.isPending} onClick={() => save.mutate()}>
          {t('app.save')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {save.isError && <InlineError>{errorText(save.error, t)}</InlineError>}
        <Field label={t('admin.code')} hint="UPPER_SNAKE_CASE">{(id, d) => <Input id={id} aria-describedby={d} value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} />}</Field>
        <Field label={t('admin.nameUk')}>{(id) => <Input id={id} value={v.nameUk} onChange={(e) => setV({ ...v, nameUk: e.target.value })} />}</Field>
        <Field label={t('admin.nameEn')}>{(id) => <Input id={id} value={v.nameEn} onChange={(e) => setV({ ...v, nameEn: e.target.value })} />}</Field>
      </div>
    </Dialog>
  );
}

function StructureTab() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const s = useStructure();
  const [adding, setAdding] = useState<'institutes' | 'departments' | null>(null);
  const toggle = useMutation({
    mutationFn: ({ kind, id, isActive }: { kind: string; id: string; isActive: boolean }) => api(`/admin/tenants/${me.tenantId}/${kind}/${id}`, { method: 'PATCH', body: { isActive } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'structure'] }),
  });
  const promote = useMutation({
    mutationFn: (dryRun: boolean) =>
      api<{ dryRun: boolean; promoted: { code: string; from: number; to: number }[]; readyToGraduate: { code: string }[] }>(`/admin/tenants/${me.tenantId}/academic-groups/promote`, {
        method: 'POST',
        body: { dryRun },
      }),
    onSuccess: (r) => !r.dryRun && void qc.invalidateQueries({ queryKey: ['admin', 'structure'] }),
  });
  const provision = useMutation({ mutationFn: () => api(`/admin/tenants/${me.tenantId}/channels/provision`, { method: 'POST' }) });

  if (s.isPending) return <Skeleton className="h-96" />;
  if (s.isError) return <InlineError>{errorText(s.error, t)}</InlineError>;
  const d = s.data;
  const named = (kind: 'institutes' | 'departments', rows: Structure['departments']) => (
    <Panel
      title={`${t(`admin.${kind}`)} · ${rows.length}`}
      actions={
        <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setAdding(kind)}>
          {t('admin.add')}
        </Button>
      }
    >
      <Table head={[t('admin.code'), t('admin.nameUk'), t('admin.nameEn'), t('admin.active')]}>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="px-2 py-2 font-mono text-xs">{r.code}</td>
            <td className="px-2 py-2">{r.nameUk}</td>
            <td className="px-2 py-2 text-muted">{r.nameEn}</td>
            <td className="px-2 py-2">
              <Toggle checked={r.isActive !== false} label="" onChange={(isActive) => toggle.mutate({ kind, id: r.id, isActive })} />
            </td>
          </tr>
        ))}
      </Table>
    </Panel>
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="body-5">
        {pick(i18n.language, d.tenant.nameUk, d.tenant.nameEn)} <Badge tone="navy">{d.tenant.code}</Badge>
      </p>
      {toggle.isError && <InlineError>{errorText(toggle.error, t)}</InlineError>}
      {named('institutes', d.institutes)}
      {named('departments', d.departments)}
      <Panel title={`${t('admin.orgUnits')} · ${d.orgUnits.length}`}>
        <Table head={[t('admin.code'), t('admin.nameUk'), t('admin.kind'), t('admin.e2ee'), t('admin.confidential')]}>
          {d.orgUnits.map((o) => (
            <tr key={o.id}>
              <td className="px-2 py-2 font-mono text-xs">{o.code}</td>
              <td className="px-2 py-2">{o.nameUk}</td>
              <td className="px-2 py-2 caption-5 text-muted">{o.kind}</td>
              <td className="px-2 py-2">
                <Badge tone={o.e2eeMode === 'MANDATORY' ? 'navy' : 'neutral'}>{o.e2eeMode}</Badge>
              </td>
              <td className="px-2 py-2">{o.confidential ? <Badge tone="accent">{t('admin.confidential')}</Badge> : null}</td>
            </tr>
          ))}
        </Table>
      </Panel>
      <Panel title={`${t('admin.dormitories')} · ${d.dormitories.length}`}>
        <ul className="grid gap-2 sm:grid-cols-2">
          {d.dormitories.map((x) => (
            <li key={x.id} className="rounded-xl border border-line px-3 py-2 body-6">
              № {x.number} · {pick(i18n.language, x.nameUk, x.nameEn)}
            </li>
          ))}
        </ul>
      </Panel>
      <Panel
        title={`${t('admin.groups')} · ${d.academicGroups.length}`}
        actions={
          <span className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" loading={promote.isPending && promote.variables === true} onClick={() => promote.mutate(true)}>
              {t('admin.promoteDry')}
            </Button>
            <Button size="sm" loading={promote.isPending && promote.variables === false} onClick={() => promote.mutate(false)}>
              {t('admin.promote')}
            </Button>
            <Button size="sm" variant="secondary" loading={provision.isPending} onClick={() => provision.mutate()}>
              {t('admin.provision')}
            </Button>
          </span>
        }
      >
        {promote.isError && <InlineError>{errorText(promote.error, t)}</InlineError>}
        {provision.isError && <InlineError>{errorText(provision.error, t)}</InlineError>}
        {promote.data && (
          <p role="status" className="rounded-lg bg-surface-2 px-3 py-2 caption-4">
            {promote.data.dryRun ? t('admin.promoteDry') : t('app.saved')}: {promote.data.promoted.map((g) => `${g.code} ${g.from}→${g.to}`).join(', ') || '—'}
          </p>
        )}
        <ul className="flex flex-wrap gap-2">
          {d.academicGroups.map((g) => (
            <li key={g.id} className="rounded-full bg-surface-hover px-3 py-1 caption-4">
              {g.code} · {g.courseYear}
            </li>
          ))}
        </ul>
      </Panel>
      <AddNamedDialog kind={adding ?? 'institutes'} open={adding !== null} onClose={() => setAdding(null)} />
    </div>
  );
}

// ─────────────────────────── Roles ───────────────────────────

function UserName({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const c = useCard(id);
  return <>{c.data ? pick(i18n.language, c.data.fullNameUk, c.data.fullNameEn) : c.isPending ? '…' : t('chats.hiddenUser')}</>;
}

function RolesTab() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const structure = useStructure();
  const list = useQuery({ queryKey: ['admin', 'roles', me.tenantId], queryFn: () => api<RoleAssignment[]>(`/admin/tenants/${me.tenantId}/role-assignments`) });
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<UserCard | null>(null);
  const [role, setRole] = useState('LECTURER');
  const [scope, setScope] = useState<{ instituteId?: string; departmentId?: string; orgUnitId?: string; dormitoryId?: string }>({});
  const [expiresAt, setExpiresAt] = useState('');
  const grant = useMutation({
    mutationFn: () =>
      api(`/admin/tenants/${me.tenantId}/role-assignments`, {
        method: 'POST',
        body: { userId: user!.id, role, ...scope, ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'roles'] });
      setOpen(false);
      setUser(null);
      setScope({});
      setExpiresAt('');
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/admin/tenants/${me.tenantId}/role-assignments/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'roles'] }),
  });
  const s = structure.data;
  const nameOf = (r: RoleAssignment) => {
    const x =
      (r.instituteId && s?.institutes.find((i) => i.id === r.instituteId)) ||
      (r.departmentId && s?.departments.find((i) => i.id === r.departmentId)) ||
      (r.orgUnitId && s?.orgUnits.find((i) => i.id === r.orgUnitId)) ||
      null;
    if (x) return pick(i18n.language, x.nameUk, x.nameEn);
    if (r.dormitoryId) return `№ ${s?.dormitories.find((d) => d.id === r.dormitoryId)?.number ?? '?'}`;
    return r.tenantId === null ? t('admin.crossTenant') : '—';
  };

  return (
    <Panel
      title={t('admin.roles')}
      actions={
        <Button size="sm" icon={<Plus size={16} />} onClick={() => setOpen(true)}>
          {t('admin.grant')}
        </Button>
      }
    >
      {revoke.isError && <InlineError>{errorText(revoke.error, t)}</InlineError>}
      {list.isPending && <Skeleton className="h-48" />}
      {list.isError && <InlineError>{errorText(list.error, t)}</InlineError>}
      {list.data && (
        <Table head={[t('admin.user'), t('admin.role'), t('admin.scope'), t('admin.source'), t('admin.expires'), '']}>
          {list.data.map((r) => (
            <tr key={r.id}>
              <td className="px-2 py-2">
                <UserName id={r.userId} />
              </td>
              <td className="px-2 py-2">
                <Badge tone="navy">{r.role}</Badge>
              </td>
              <td className="px-2 py-2 caption-5">{nameOf(r)}</td>
              <td className="px-2 py-2 caption-5 text-muted">{r.source}</td>
              <td className="px-2 py-2 caption-5 text-muted">{r.expiresAt ? formatDateTime(r.expiresAt, i18n.language) : '—'}</td>
              <td className="px-2 py-2 text-right">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={r.source === 'SYNC' || r.userId === me.userId}
                  title={r.source === 'SYNC' ? t('admin.syncOwned') : undefined}
                  onClick={() => revoke.mutate(r.id)}
                >
                  {t('admin.revoke')}
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('admin.grant')}
        footer={
          <Button disabled={!user} loading={grant.isPending} onClick={() => grant.mutate()}>
            {t('admin.grant')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {grant.isError && <InlineError>{errorText(grant.error, t)}</InlineError>}
          {user ? (
            <p className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2 body-5">
              {pick(i18n.language, user.fullNameUk, user.fullNameEn)}
              <Button size="sm" variant="ghost" onClick={() => setUser(null)}>
                {t('app.cancel')}
              </Button>
            </p>
          ) : (
            <PeopleSearch exclude={[me.userId]} onPick={setUser} />
          )}
          <Field label={t('admin.role')}>
            {(id) => (
              <Select id={id} value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLES.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </Select>
            )}
          </Field>
          {s && (role === 'INSTITUTE_DIRECTOR' || role === 'DEPARTMENT_HEAD' || role === 'ADMIN_STAFF' || role === 'TRUST_SERVICE_OFFICER' || role === 'DORM_COMMANDANT') && (
            <Field label={t('admin.scope')}>
              {(id) => (
                <Select
                  id={id}
                  value={Object.values(scope)[0] ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setScope(
                      role === 'INSTITUTE_DIRECTOR' ? { instituteId: v } : role === 'DEPARTMENT_HEAD' ? { departmentId: v } : role === 'DORM_COMMANDANT' ? { dormitoryId: v } : { orgUnitId: v },
                    );
                  }}
                >
                  <option value="">—</option>
                  {(role === 'INSTITUTE_DIRECTOR' ? s.institutes : role === 'DEPARTMENT_HEAD' ? s.departments : role === 'DORM_COMMANDANT' ? [] : s.orgUnits).map((x) => (
                    <option key={x.id} value={x.id}>
                      {pick(i18n.language, x.nameUk, x.nameEn)}
                    </option>
                  ))}
                  {role === 'DORM_COMMANDANT' &&
                    s.dormitories.map((x) => (
                      <option key={x.id} value={x.id}>
                        № {x.number}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          )}
          <Field label={t('admin.expires')} hint={role === 'GUEST' ? 'GUEST: TTL' : undefined}>
            {(id, d) => <Input id={id} aria-describedby={d} type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />}
          </Field>
        </div>
      </Dialog>
    </Panel>
  );
}

// ─────────────────────────── Matrix ───────────────────────────

function MatrixTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const m = useQuery({ queryKey: ['admin', 'matrix'], queryFn: () => api<PermissionMatrix>('/admin/permissions') });
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [role, setRole] = useState('LECTURER');
  useEffect(() => {
    if (m.data) setDraft(m.data.roles);
  }, [m.data]);
  const save = useMutation({
    mutationFn: () => api(`/admin/permissions/${role}`, { method: 'PUT', body: { actions: draft[role] ?? [] } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'matrix'] }),
  });
  if (m.isPending) return <Skeleton className="h-96" />;
  if (m.isError) return <InlineError>{errorText(m.error, t)}</InlineError>;
  const current = new Set(draft[role] ?? []);
  const dirty = JSON.stringify([...current].sort()) !== JSON.stringify([...(m.data.roles[role] ?? [])].sort());
  return (
    <Panel
      title={t('admin.matrix')}
      actions={<Badge tone={m.data.source === 'database' ? 'navy' : 'neutral'}>{t(`admin.matrixSource.${m.data.source}`)}</Badge>}
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('admin.role')}>
          {(id) => (
            <Select id={id} value={role} onChange={(e) => setRole(e.target.value)}>
              {Object.keys(m.data.roles)
                .filter((r) => r !== 'INTEGRATION')
                .map((r) => (
                  <option key={r}>{r}</option>
                ))}
            </Select>
          )}
        </Field>
        <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
          {t('app.save')}
        </Button>
        {save.isSuccess && !dirty && <span className="caption-4 text-success">{t('app.saved')}</span>}
      </div>
      {save.isError && <InlineError>{errorText(save.error, t)}</InlineError>}
      <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {m.data.actions.map((a) => (
          <li key={a}>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 font-mono text-xs leading-4 hover:bg-surface-hover">
              <input
                type="checkbox"
                className="size-4 accent-[var(--puet-navy-primary)]"
                checked={current.has(a)}
                onChange={(e) => setDraft((d) => ({ ...d, [role]: e.target.checked ? [...(d[role] ?? []), a] : (d[role] ?? []).filter((x) => x !== a) }))}
              />
              {a}
            </label>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ─────────────────────────── Policies ───────────────────────────

const EMPTY_POLICY = { key: '', description: '', effect: 'DENY' as 'ALLOW' | 'DENY', actions: '*', resourceTypes: '*', condition: '{\n  "all": []\n}', priority: 0, enabled: true };

function PoliciesTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['admin', 'policies'], queryFn: () => api<AbacPolicy[]>('/admin/policies') });
  const [edit, setEdit] = useState<(typeof EMPTY_POLICY & { id?: string }) | null>(null);
  const [jsonError, setJsonError] = useState(false);
  const save = useMutation({
    mutationFn: () => {
      const e = edit!;
      let condition: unknown;
      try {
        condition = JSON.parse(e.condition);
      } catch {
        setJsonError(true);
        throw new Error('json');
      }
      const body = {
        description: e.description || undefined,
        effect: e.effect,
        actions: e.actions.split(',').map((x) => x.trim()).filter(Boolean),
        resourceTypes: e.resourceTypes.split(',').map((x) => x.trim()).filter(Boolean),
        condition,
        priority: e.priority,
        enabled: e.enabled,
      };
      return e.id ? api(`/admin/policies/${e.id}`, { method: 'PATCH', body }) : api('/admin/policies', { method: 'POST', body: { ...body, key: e.key } });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'policies'] });
      setEdit(null);
    },
  });
  return (
    <Panel
      title={t('admin.policies')}
      actions={
        <Button size="sm" icon={<Plus size={16} />} onClick={() => setEdit({ ...EMPTY_POLICY })}>
          {t('admin.newPolicy')}
        </Button>
      }
    >
      {list.isPending && <Skeleton className="h-32" />}
      {list.isError && <InlineError>{errorText(list.error, t)}</InlineError>}
      {list.data?.length === 0 && <EmptyState icon={<ShieldStar size={28} />} title={t('admin.newPolicy')} />}
      {list.data && list.data.length > 0 && (
        <Table head={[t('admin.policyKey'), t('admin.effect'), t('admin.actions'), t('admin.priority'), t('admin.enabled'), '']}>
          {list.data.map((p) => (
            <tr key={p.id}>
              <td className="px-2 py-2 font-mono text-xs">{p.key}</td>
              <td className="px-2 py-2">
                <Badge tone={p.effect === 'DENY' ? 'danger' : 'success'}>{p.effect}</Badge>
              </td>
              <td className="max-w-64 truncate px-2 py-2 font-mono text-xs">{p.actions.join(', ')}</td>
              <td className="px-2 py-2">{p.priority}</td>
              <td className="px-2 py-2">{p.enabled ? '✓' : '—'}</td>
              <td className="px-2 py-2 text-right">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setEdit({
                      id: p.id,
                      key: p.key,
                      description: p.description ?? '',
                      effect: p.effect,
                      actions: p.actions.join(', '),
                      resourceTypes: p.resourceTypes.join(', '),
                      condition: JSON.stringify(p.condition, null, 2),
                      priority: p.priority,
                      enabled: p.enabled,
                    })
                  }
                >
                  {t('message.edit')}
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <Dialog
        wide
        open={edit !== null}
        onClose={() => setEdit(null)}
        title={edit?.id ? edit.key : t('admin.newPolicy')}
        footer={
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.save')}
          </Button>
        }
      >
        {edit && (
          <div className="flex flex-col gap-3">
            {save.isError && !jsonError && <InlineError>{errorText(save.error, t)}</InlineError>}
            {!edit.id && <Field label={t('admin.policyKey')}>{(id) => <Input id={id} value={edit.key} onChange={(e) => setEdit({ ...edit, key: e.target.value })} />}</Field>}
            <Field label="Description">{(id) => <Input id={id} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />}</Field>
            <div className="flex flex-wrap gap-4">
              <Field label={t('admin.effect')}>
                {(id) => (
                  <Select id={id} value={edit.effect} onChange={(e) => setEdit({ ...edit, effect: e.target.value as 'ALLOW' | 'DENY' })}>
                    <option>DENY</option>
                    <option>ALLOW</option>
                  </Select>
                )}
              </Field>
              <Field label={t('admin.priority')}>{(id) => <Input id={id} type="number" min={-1000} max={1000} value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: Number(e.target.value) })} />}</Field>
              <div className="self-end pb-2">
                <Toggle checked={edit.enabled} onChange={(enabled) => setEdit({ ...edit, enabled })} label={t('admin.enabled')} />
              </div>
            </div>
            <Field label={t('admin.actions')} hint="message.send, file.download, *">{(id, d) => <Input id={id} aria-describedby={d} value={edit.actions} onChange={(e) => setEdit({ ...edit, actions: e.target.value })} />}</Field>
            <Field label={t('admin.resourceTypes')} hint="channel, file, *">{(id, d) => <Input id={id} aria-describedby={d} value={edit.resourceTypes} onChange={(e) => setEdit({ ...edit, resourceTypes: e.target.value })} />}</Field>
            <Field label={t('admin.condition')} error={jsonError ? t('admin.invalidJson') : undefined}>
              {(id, d) => (
                <TextArea
                  id={id}
                  aria-describedby={d}
                  rows={8}
                  spellCheck={false}
                  className="font-mono text-xs leading-4"
                  value={edit.condition}
                  onChange={(e) => {
                    setJsonError(false);
                    setEdit({ ...edit, condition: e.target.value });
                  }}
                />
              )}
            </Field>
          </div>
        )}
      </Dialog>
    </Panel>
  );
}

// ─────────────────────────── Simulator ───────────────────────────

function SimulatorTab() {
  const { t, i18n } = useTranslation();
  const matrix = useQuery({ queryKey: ['admin', 'matrix'], queryFn: () => api<PermissionMatrix>('/admin/permissions') });
  const [user, setUser] = useState<UserCard | null>(null);
  const [action, setAction] = useState('message.send');
  const [type, setType] = useState('channel');
  const [rid, setRid] = useState('');
  const run = useMutation({
    mutationFn: () => api<Decision>('/admin/policies/simulate', { method: 'POST', body: { userId: user!.id, action, resource: { type, ...(rid.trim() ? { id: rid.trim() } : {}) } } }),
  });
  return (
    <Panel title={t('admin.simulator')}>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <p className="title-4">{t('admin.user')}</p>
          {user ? (
            <p className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2 body-5">
              {pick(i18n.language, user.fullNameUk, user.fullNameEn)}
              <Button size="sm" variant="ghost" onClick={() => setUser(null)}>
                {t('app.cancel')}
              </Button>
            </p>
          ) : (
            <PeopleSearch onPick={setUser} />
          )}
        </div>
        <div className="flex flex-col gap-3">
          <Field label={t('admin.action')}>
            {(id) => (
              <Select id={id} value={action} onChange={(e) => setAction(e.target.value)}>
                {(matrix.data?.actions ?? [action]).map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('admin.resourceType')}>
            {(id) => (
              <Select id={id} value={type} onChange={(e) => setType(e.target.value)}>
                {['channel', 'message', 'file', 'user', 'directory', 'structure', 'role', 'policy', 'audit', 'certificate', 'self'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('admin.resourceId')}>{(id) => <Input id={id} value={rid} placeholder="UUID" onChange={(e) => setRid(e.target.value)} />}</Field>
          <Button className="self-start" disabled={!user} loading={run.isPending} onClick={() => run.mutate()}>
            {t('admin.simulate')}
          </Button>
        </div>
      </div>
      {run.isError && <InlineError>{errorText(run.error, t)}</InlineError>}
      {run.data && (
        <div role="status" className={cx('flex items-center gap-3 rounded-xl px-4 py-3', run.data.allowed ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger')}>
          {run.data.allowed ? <CheckCircle size={24} weight="fill" /> : <Warning size={24} weight="fill" />}
          <span className="body-4">{run.data.allowed ? t('admin.allowed') : t('admin.denied')}</span>
          {run.data.reason && (
            <span className="font-mono text-xs">
              {t('admin.reason')}: {run.data.reason}
            </span>
          )}
        </div>
      )}
    </Panel>
  );
}

// ─────────────────────────── Audit ───────────────────────────

function AuditTab() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const [outcome, setOutcome] = useState('');
  const [action, setAction] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['admin', 'audit', me.tenantId, outcome, action],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50' });
      if (pageParam) p.set('beforeId', pageParam);
      if (outcome) p.set('outcome', outcome);
      if (action.trim()) p.set('action', action.trim());
      return api<{ items: AuditEntry[]; nextBeforeId: string | null }>(`/admin/tenants/${me.tenantId}/audit?${p}`);
    },
    getNextPageParam: (last) => (last.items.length < 50 ? undefined : (last.nextBeforeId ?? undefined)),
  });
  const verify = useMutation({ mutationFn: () => api<{ checked: number; intact: boolean; firstBrokenId: string | null }>('/admin/audit/verify?limit=10000') });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  return (
    <Panel
      title={t('admin.audit')}
      actions={
        <Button size="sm" variant="secondary" icon={<LinkSimple size={16} />} loading={verify.isPending} onClick={() => verify.mutate()}>
          {t('admin.verifyChain')}
        </Button>
      }
    >
      {verify.data && (
        <p role="status" className={cx('rounded-lg px-3 py-2 body-5', verify.data.intact ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger')}>
          {verify.data.intact ? t('admin.chainOk', { count: verify.data.checked }) : t('admin.chainBroken', { id: verify.data.firstBrokenId })}
        </p>
      )}
      {verify.isError && <InlineError>{errorText(verify.error, t)}</InlineError>}
      <div className="flex flex-wrap gap-3">
        <Field label={t('admin.outcome')}>
          {(id) => (
            <Select id={id} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="">—</option>
              <option>SUCCESS</option>
              <option>DENIED</option>
              <option>FAILURE</option>
            </Select>
          )}
        </Field>
        <Field label={t('admin.action')}>{(id) => <Input id={id} value={action} placeholder="file.download" onChange={(e) => setAction(e.target.value)} />}</Field>
      </div>
      {q.isPending && <Skeleton className="h-64" />}
      {q.isError && <InlineError>{errorText(q.error, t)}</InlineError>}
      {q.data && (
        <Table head={[t('admin.time'), t('admin.actor'), t('admin.action'), t('admin.resource'), t('admin.outcome'), t('admin.reason')]}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-2 py-2 caption-5 whitespace-nowrap">{formatDateTime(r.occurredAt, i18n.language)}</td>
              <td className="px-2 py-2 caption-5">{r.actorId ? <UserName id={r.actorId} /> : '—'}</td>
              <td className="px-2 py-2 font-mono text-xs">{r.action}</td>
              <td className="px-2 py-2 font-mono text-xs text-muted">{r.resourceType ?? ''}</td>
              <td className="px-2 py-2">
                <Badge tone={r.outcome === 'SUCCESS' ? 'success' : r.outcome === 'DENIED' ? 'danger' : 'accent'}>{r.outcome}</Badge>
              </td>
              <td className="px-2 py-2 font-mono text-xs text-muted">{r.reason ?? ''}</td>
            </tr>
          ))}
        </Table>
      )}
      {q.hasNextPage && (
        <Button variant="secondary" className="self-center" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {t('admin.loadMore')}
        </Button>
      )}
    </Panel>
  );
}

const TABS = [
  ['', 'structure'],
  ['roles', 'roles'],
  ['matrix', 'matrix'],
  ['policies', 'policies'],
  ['simulator', 'simulator'],
  ['audit', 'audit'],
] as const;

/** No-Code Admin Panel. Every call is authorized server-side (RBAC + scope + MFA); this UI only hides what cannot work. */
export default function AdminPage() {
  const { t } = useTranslation();
  const me = useMe();
  if (!isAdmin(me)) {
    return (
      <main id="main" className="flex flex-1 items-center justify-center">
        <EmptyState icon={<ShieldStar size={28} />} title={t('admin.noAccess')} />
      </main>
    );
  }
  return (
    <main id="main" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6">
        <h1 className="heading-5">{t('admin.title')}</h1>
        {me.mfaRequired && !me.mfaVerified && <InlineError>{t('admin.mfaStepUp')}</InlineError>}
        <nav aria-label={t('admin.title')} className="flex gap-1 overflow-x-auto rounded-xl bg-surface p-1 ring-1 ring-line">
          {TABS.map(([path, key]) => (
            <NavLink
              key={key}
              end
              to={path ? `/admin/${path}` : '/admin'}
              className={({ isActive }) => cx('rounded-lg px-3 py-2 button-sm whitespace-nowrap transition-colors duration-300 ease-pulse', isActive ? 'bg-primary text-on-primary' : 'text-muted hover:bg-surface-hover')}
            >
              {t(`admin.${key}`)}
            </NavLink>
          ))}
        </nav>
        <Routes>
          <Route index element={<StructureTab />} />
          <Route path="roles" element={<RolesTab />} />
          <Route path="matrix" element={<MatrixTab />} />
          <Route path="policies" element={<PoliciesTab />} />
          <Route path="simulator" element={<SimulatorTab />} />
          <Route path="audit" element={<AuditTab />} />
        </Routes>
      </div>
    </main>
  );
}
