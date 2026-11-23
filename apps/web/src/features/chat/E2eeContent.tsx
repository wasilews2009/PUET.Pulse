import { ChartBar, DownloadSimple, Eye, File as FileIcon, FileImage, FilePdf, FileText, Lock, Plus, Trash, WarningCircle } from '@phosphor-icons/react';
import type { EncryptedFileInfo } from '@puet/e2ee';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, apiBytes } from '../../api/client';
import { keys, upsertMessage, useMembers, useMessages } from '../../api/queries';
import type { Channel, Member, Message } from '../../api/types';
import { Button, cx, Dialog, Field, formatBytes, InlineError, Input } from '../../components/ui';
import { getCrypto } from '../../e2ee/crypto';
import { useMe } from '../../session/session';
import type { PdfDoc } from '../files/pdf';
import { PdfPage } from '../files/PdfPage';
import { decryptOptions, type Plain } from './useDecrypted';

/**
 * Content of end-to-end encrypted rooms beyond text (Phase 9): attachments
 * (AES-256-GCM per file, key inside the Megolm message, ciphertext on the
 * server) and polls (Megolm events, tallied on each device). The server can
 * neither read nor scan any of it, so files are checked here: only the types
 * the API would accept, recognised from their bytes, and shown only in
 * sandboxed viewers (images as blob: <img>, PDFs on a canvas via PDF.js).
 */

export const POLL_START = 'puet.poll.start';
export const POLL_RESPONSE = 'puet.poll.response';
export const POLL_END = 'puet.poll.end';
export const FILE_MSG = 'puet.file';

export const MAX_E2EE_MB = 50;

export type SafeType = 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp' | 'text/plain';

/** The type of a file, from its bytes only, against the same allowlist as the API. */
export function sniffSafeType(b: Uint8Array): SafeType | null {
  const starts = (...sig: number[]) => sig.every((x, i) => b[i] === x);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  // Text: valid UTF-8 without control characters other than whitespace.
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, 65_536));
    // eslint-disable-next-line no-control-regex
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) return 'text/plain';
  } catch {
    /* not text */
  }
  return null;
}

export interface FileContent {
  name: string;
  mimetype: SafeType;
  size: number;
  blobId: string;
  file: EncryptedFileInfo;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE: readonly string[] = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain'];

/** Content written by other devices is untrusted: every field is checked. */
export function parseFile(c: Record<string, unknown> | undefined): FileContent | null {
  if (!c || c.msgtype !== FILE_MSG || !isRecord(c.info) || !isRecord(c.file)) return null;
  const name = typeof c.body === 'string' ? c.body.slice(0, 200) : '';
  const { mimetype, size } = c.info;
  const blobId = c.file.blobId;
  if (!name || typeof mimetype !== 'string' || !SAFE.includes(mimetype) || typeof size !== 'number' || typeof blobId !== 'string' || !UUID.test(blobId)) return null;
  return { name, mimetype: mimetype as SafeType, size, blobId, file: c.file as unknown as EncryptedFileInfo };
}

export interface PollContent {
  question: string;
  choices: { id: string; text: string }[];
}

export function parsePoll(c: Record<string, unknown> | undefined): PollContent | null {
  if (!c || c.msgtype !== POLL_START || typeof c.question !== 'string' || !Array.isArray(c.choices)) return null;
  const choices = c.choices
    .filter((x): x is { id: string; text: string } => isRecord(x) && typeof x.id === 'string' && typeof x.text === 'string')
    .slice(0, 10)
    .map((x) => ({ id: x.id.slice(0, 16), text: x.text.slice(0, 200) }));
  if (choices.length < 2) return null;
  return { question: c.question.slice(0, 300), choices };
}

/** Votes and poll ends are folded into their poll card, not shown as messages. */
export const isPollEvent = (c: Record<string, unknown> | undefined) => c?.msgtype === POLL_RESPONSE || c?.msgtype === POLL_END;

function clientId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Sends any Megolm event content to the room (text, files, polls). */
export function useSendContent(channel: Channel) {
  const qc = useQueryClient();
  const me = useMe();
  return useMutation({
    mutationFn: async (content: Record<string, unknown>): Promise<Message> => {
      const members = await qc.fetchQuery({ queryKey: keys.members(channel.id), queryFn: () => api<Member[]>(`/channels/${channel.id}/members`), staleTime: 30_000 });
      const c = await getCrypto(me.userId);
      const sealed = await c.encrypt(
        channel.id,
        members.map((m) => m.userId),
        content,
      );
      const sent = await api<Message>(`/channels/${channel.id}/messages`, {
        method: 'POST',
        body: { clientMessageId: clientId(), ciphertext: sealed.ciphertext, scheme: sealed.scheme, senderDeviceId: c.machine.deviceId.toString() },
      });
      qc.setQueryData<Plain>(['plain', sent.id, sent.editedAt ?? ''], { text: typeof content.body === 'string' ? content.body : '', encrypted: true, failed: false, verified: true, content });
      return sent;
    },
    onSuccess: (m) => upsertMessage(qc, m),
  });
}

/** Encrypts a file on this device, uploads the ciphertext and sends the key in a Megolm message. */
export function useSendEncryptedFile(channel: Channel) {
  const send = useSendContent(channel);
  return useMutation({
    mutationFn: async (f: globalThis.File) => {
      if (f.size > MAX_E2EE_MB * 1024 * 1024) throw new Error('too-large');
      const bytes = new Uint8Array(await f.arrayBuffer());
      const type = sniffSafeType(bytes);
      if (!type) throw new Error('type');
      const { encryptAttachment } = await import('@puet/e2ee');
      const { ciphertext, info } = await encryptAttachment(bytes);
      const blob = await api<{ blobId: string }>(`/channels/${channel.id}/blobs`, { method: 'POST', body: ciphertext });
      return send.mutateAsync({
        msgtype: FILE_MSG,
        body: f.name.slice(0, 200) || 'file',
        info: { mimetype: type, size: bytes.length },
        file: { ...info, blobId: blob.blobId },
      });
    },
  });
}

function TypeIcon({ type }: { type: SafeType }) {
  const Icon = type === 'application/pdf' ? FilePdf : type.startsWith('image/') ? FileImage : type === 'text/plain' ? FileText : FileIcon;
  return <Icon size={26} aria-hidden="true" className="shrink-0" />;
}

const EXT: Record<SafeType, string[]> = { 'application/pdf': ['pdf'], 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'], 'text/plain': ['txt'] };

/** The saved name always carries an extension of the checked type (no "report.html" holding text). */
export function safeName(name: string, type: SafeType): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
  const ext = clean.split('.').pop()?.toLowerCase() ?? '';
  return EXT[type].includes(ext) ? clean : `${clean}.${EXT[type][0]}`;
}

type Opened = { kind: 'image'; url: string } | { kind: 'pdf'; doc: PdfDoc } | { kind: 'text'; text: string };

/** An encrypted attachment: fetched and decrypted on demand, checked, then shown in a sandboxed viewer. */
export function AttachmentCard({ channelId, f }: { channelId: string; f: FileContent }) {
  const { t, i18n } = useTranslation();
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [page, setPage] = useState(1);
  const load = useMutation({
    mutationFn: async () => {
      const { decryptAttachment } = await import('@puet/e2ee');
      const { bytes: cipher } = await apiBytes(`/channels/${channelId}/blobs/${f.blobId}`);
      const plain = await decryptAttachment(cipher, f.file);
      // The bytes must be what the message claims, and on the allowlist.
      if (sniffSafeType(plain) !== f.mimetype) throw new Error('type');
      return plain;
    },
  });
  useEffect(() => () => (opened?.kind === 'image' ? URL.revokeObjectURL(opened.url) : undefined), [opened]);

  const get = async (): Promise<Uint8Array> => {
    if (bytes) return bytes;
    const b = await load.mutateAsync();
    setBytes(b);
    return b;
  };
  const view = async () => {
    const b = await get();
    // PDF.js loads lazily; it runs with eval and XFA off and draws on a canvas only.
    if (f.mimetype === 'application/pdf') setOpened({ kind: 'pdf', doc: await (await import('../files/pdf')).openPdf(b.slice()) });
    else if (f.mimetype === 'text/plain') setOpened({ kind: 'text', text: new TextDecoder().decode(b) });
    else setOpened({ kind: 'image', url: URL.createObjectURL(new Blob([b as BlobPart], { type: f.mimetype })) });
  };
  const save = async () => {
    const b = await get();
    const url = URL.createObjectURL(new Blob([b as BlobPart], { type: f.mimetype }));
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName(f.name, f.mimetype);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div className="flex min-w-56 flex-col gap-2">
      <div className="flex items-center gap-2">
        <TypeIcon type={f.mimetype} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate body-5">{f.name}</span>
          <span className="flex items-center gap-1 caption-5 opacity-80">
            <Lock size={12} aria-hidden="true" />
            {formatBytes(f.size, i18n.language)}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={<Eye size={16} aria-hidden="true" />} loading={load.isPending} onClick={() => void view().catch(() => undefined)}>
          {t('e2eeFile.view')}
        </Button>
        {f.mimetype !== 'application/pdf' && (
          <Button size="sm" variant="ghost" icon={<DownloadSimple size={16} aria-hidden="true" />} disabled={load.isPending} onClick={() => void save().catch(() => undefined)}>
            {t('files.download')}
          </Button>
        )}
      </div>
      {load.isError && (
        <span className="flex items-start gap-1 caption-4 text-danger">
          <WarningCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          {t('e2eeFile.failed')}
        </span>
      )}
      <Dialog open={!!opened} onClose={() => setOpened(null)} title={f.name} wide>
        {opened?.kind === 'image' && <img src={opened.url} alt={f.name} className="mx-auto max-h-[70vh] max-w-full rounded-lg" />}
        {opened?.kind === 'text' && <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 caption-2">{opened.text}</pre>}
        {opened?.kind === 'pdf' && (
          <div className="flex flex-col items-center gap-3">
            <PdfPage doc={opened.doc} pageNumber={page} scale={1.2} annotations={[]} drawing={false} onDraw={() => undefined} activeId={null} onSelect={() => undefined} label={t('e2eeFile.page', { page, total: opened.doc.numPages })} />
            <div className="flex items-center gap-3">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                ←
              </Button>
              <span className="caption-4">{t('e2eeFile.page', { page, total: opened.doc.numPages })}</span>
              <Button size="sm" variant="secondary" disabled={page >= opened.doc.numPages} onClick={() => setPage((p) => p + 1)}>
                →
              </Button>
            </div>
          </div>
        )}
        <p className="mt-3 caption-5 text-muted">{t('e2eeFile.notScanned')}</p>
      </Dialog>
    </div>
  );
}

/** Votes of an encrypted poll, counted on this device from the room's loaded history (last vote per person). */
export function tallyPoll(poll: Message, events: { m: Message; content: Record<string, unknown> | undefined }[]) {
  const votes = new Map<string, { choice: string; at: string }>();
  let closed = false;
  for (const { m, content } of events) {
    if (!content || content.poll !== poll.id || m.createdAt < poll.createdAt) continue;
    if (content.msgtype === POLL_END && m.senderId === poll.senderId) closed = true;
    if (content.msgtype === POLL_RESPONSE && typeof content.choice === 'string') {
      const prev = votes.get(m.senderId);
      if (!prev || prev.at <= m.createdAt) votes.set(m.senderId, { choice: content.choice, at: m.createdAt });
    }
  }
  const counts = new Map<string, number>();
  for (const v of votes.values()) counts.set(v.choice, (counts.get(v.choice) ?? 0) + 1);
  return { votes, counts, closed };
}

export function E2eePollCard({ m, poll, channel }: { m: Message; poll: PollContent; channel: Channel }) {
  const { t } = useTranslation();
  const me = useMe();
  const history = useMessages(channel.id, null);
  const later = (history.data?.pages.flat() ?? []).filter((x) => x.ciphertext && !x.deleted && x.createdAt >= m.createdAt && x.id !== m.id);
  const decrypted = useQueries({ queries: later.map((x) => decryptOptions(x, me.userId)) });
  const { votes, counts, closed } = tallyPoll(
    m,
    later.map((x, i) => ({ m: x, content: decrypted[i]?.data?.content })),
  );
  const send = useSendContent(channel);
  const mine = votes.get(me.userId)?.choice;
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const canEnd = m.senderId === me.userId && !closed && !channel.archived;

  return (
    <div className="flex min-w-64 flex-col gap-2">
      <span className="flex items-center gap-1 caption-3">
        <ChartBar size={14} aria-hidden="true" />
        {t('e2eePoll.badge')}
      </span>
      <p className="title-4">{poll.question}</p>
      <ul className="flex flex-col gap-1">
        {poll.choices.map((c) => {
          const n = counts.get(c.id) ?? 0;
          const share = total ? Math.round((n / total) * 100) : 0;
          return (
            <li key={c.id}>
              <button
                type="button"
                disabled={closed || send.isPending || channel.archived}
                aria-pressed={mine === c.id}
                onClick={() => send.mutate({ msgtype: POLL_RESPONSE, poll: m.id, choice: c.id, body: '' })}
                className={cx(
                  'relative flex w-full items-center justify-between gap-3 overflow-hidden rounded-lg border px-3 py-2 text-left body-6 transition-colors duration-300 ease-pulse disabled:cursor-default',
                  mine === c.id ? 'border-primary' : 'border-line hover:bg-surface-hover',
                )}
              >
                <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-primary/10" style={{ width: `${share}%` }} />
                <span className="relative">{c.text}</span>
                <span className="relative caption-4 text-muted">{n}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <span className="caption-5 text-muted">
        {closed ? t('e2eePoll.closed', { count: total }) : t('e2eePoll.votes', { count: total })} · {t('e2eePoll.openVotes')}
      </span>
      {canEnd && (
        <Button size="sm" variant="ghost" loading={send.isPending} onClick={() => send.mutate({ msgtype: POLL_END, poll: m.id, body: '' })}>
          {t('e2eePoll.end')}
        </Button>
      )}
    </div>
  );
}

export function NewE2eePollDialog({ channel, open, onClose }: { channel: Channel; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState('');
  const [choices, setChoices] = useState(['', '']);
  const send = useSendContent(channel);
  const members = useMembers(channel.id);
  const filled = choices.map((c) => c.trim()).filter(Boolean);
  const valid = question.trim().length > 0 && filled.length >= 2;
  const submit = () =>
    send.mutate(
      { msgtype: POLL_START, body: question.trim(), question: question.trim(), choices: filled.map((text, i) => ({ id: `c${i + 1}`, text })) },
      {
        onSuccess: () => {
          setQuestion('');
          setChoices(['', '']);
          onClose();
        },
      },
    );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('e2eePoll.create')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={!valid} loading={send.isPending} onClick={submit}>
            {t('e2eePoll.publish')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="caption-4 text-muted">{t('e2eePoll.hint', { count: members.data?.length ?? 0 })}</p>
        <Field label={t('e2eePoll.question')}>{(id) => <Input id={id} value={question} maxLength={300} onChange={(e) => setQuestion(e.target.value)} />}</Field>
        {choices.map((c, i) => (
          <div key={i} className="flex items-end gap-2">
            <div className="flex-1">
              <Field label={t('e2eePoll.choice', { n: i + 1 })}>
                {(id) => <Input id={id} value={c} maxLength={200} onChange={(e) => setChoices((l) => l.map((x, j) => (j === i ? e.target.value : x)))} />}
              </Field>
            </div>
            {choices.length > 2 && (
              <Button variant="ghost" size="sm" aria-label={t('e2eePoll.removeChoice')} icon={<Trash size={16} aria-hidden="true" />} onClick={() => setChoices((l) => l.filter((_, j) => j !== i))} />
            )}
          </div>
        ))}
        {choices.length < 10 && (
          <Button variant="ghost" size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setChoices((l) => [...l, ''])}>
            {t('e2eePoll.addChoice')}
          </Button>
        )}
        {send.isError && <InlineError>{t('app.error')}</InlineError>}
      </div>
    </Dialog>
  );
}
