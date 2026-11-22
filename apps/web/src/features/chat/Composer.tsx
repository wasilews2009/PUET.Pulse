import { Paperclip, PaperPlaneRight } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { keys } from '../../api/queries';
import type { Channel, FileItem } from '../../api/types';
import { cx, IconButton, InlineError, Toggle } from '../../components/ui';
import { getSocket } from '../../realtime/socket';
import { useSend } from './useSend';

const MAX_MB = 50;

export function Composer({ channel, threadRootId = null, onUploaded }: { channel: Channel; threadRootId?: string | null; onUploaded?: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confidential, setConfidential] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const send = useSend(channel, threadRootId);
  // The server cannot scan client-encrypted bytes, so MANDATORY E2EE channels take no attachments yet.
  const attachAllowed = channel.e2eeMode !== 'MANDATORY' && !threadRootId;

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > MAX_MB * 1024 * 1024) throw new Error('too-large');
      return api<FileItem>(`/channels/${channel.id}/files${confidential ? '?confidential=true' : ''}`, {
        method: 'POST',
        body: new Uint8Array(await file.arrayBuffer()),
        headers: { 'x-file-name': encodeURIComponent(file.name) },
      });
    },
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: keys.files(channel.id) });
      onUploaded?.();
    },
    onError: (e) => setError(e instanceof Error && e.message === 'too-large' ? t('files.tooLarge', { mb: MAX_MB }) : e instanceof ApiError && e.status === 413 ? t('files.tooLarge', { mb: MAX_MB }) : t('files.uploadFailed')),
  });

  const submit = () => {
    const body = text.trim();
    if (!body || send.isPending) return;
    send.mutate(body, {
      onSuccess: () => {
        setText('');
        setError(null);
      },
      onError: () => setError(t('message.failed')),
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onChange = (v: string) => {
    setText(v);
    const now = Date.now();
    if (now - lastTyping.current > 3000) {
      lastTyping.current = now;
      getSocket().emit('typing', { channelId: channel.id });
    }
  };

  return (
    <div className="border-t border-line bg-surface px-4 py-3">
      {error && (
        <div className="mb-2">
          <InlineError>{error}</InlineError>
        </div>
      )}
      {upload.isPending && (
        <p role="status" className="mb-2 caption-4 text-muted">
          {t('files.uploading')}
        </p>
      )}
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {!threadRootId && (
          <>
            <input
              ref={fileInput}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload.mutate(f);
                e.target.value = '';
              }}
            />
            <IconButton
              label={attachAllowed ? t('message.attach') : t('message.attachDisabledE2ee')}
              disabled={!attachAllowed || upload.isPending}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip size={22} />
            </IconButton>
          </>
        )}
        <label className="min-w-0 flex-1">
          <span className="sr-only">{threadRootId ? t('message.placeholderThread') : t('message.placeholder')}</span>
          <textarea
            rows={1}
            value={text}
            maxLength={20_000}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKey}
            placeholder={threadRootId ? t('message.placeholderThread') : t('message.placeholder')}
            className="block max-h-40 min-h-10 w-full resize-none rounded-xl border border-line bg-surface-2 px-3 py-2 body-6 [field-sizing:content] placeholder:text-muted focus:border-primary focus:outline-none"
          />
        </label>
        <button
          type="submit"
          aria-label={t('message.send')}
          title={t('message.send')}
          disabled={!text.trim() || send.isPending}
          className={cx(
            'flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-on-accent transition-[background-color,transform,opacity] duration-300 ease-pulse hover:bg-accent-hover active:scale-[0.98] disabled:opacity-40',
          )}
        >
          <PaperPlaneRight size={20} weight="fill" />
        </button>
      </form>
      {attachAllowed && !threadRootId && channel.type !== 'DIRECT' && channel.type !== 'PRIVATE_GROUP' && (
        <div className="mt-2">
          <Toggle checked={confidential} onChange={setConfidential} label={t('message.attachConfidential')} />
        </div>
      )}
    </div>
  );
}
