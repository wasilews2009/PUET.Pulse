import { CheckCircle, Certificate as CertIcon, UploadSimple } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api, ApiError } from '../../api/client';
import { keys } from '../../api/queries';
import type { Certificate, Signature } from '../../api/types';
import { Button, cx, Dialog, InlineError } from '../../components/ui';
import { useMe } from '../../session/session';
import { loadKey } from './keystore';

interface SigningInfo {
  fileId: string;
  sha256: string;
  digestAlgorithm: 'SHA-256';
  providers: { INTERNAL_PKI: boolean; EXTERNAL_QES: boolean };
}

function toB64(bytes: Uint8Array) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** The internal certificate whose private key lives in this browser, if it is still active. */
export function useLocalCertificate() {
  const me = useMe();
  const certs = useQuery({ queryKey: keys.certificates, queryFn: () => api<Certificate[]>('/me/certificates') });
  const local = useQuery({ queryKey: ['local-key', me.userId], queryFn: async () => (await loadKey(me.userId)) ?? null });
  const cert = certs.data?.find((c) => c.id === local.data?.certificateId && c.status === 'ACTIVE' && c.provider === 'INTERNAL_PKI') ?? null;
  return { cert, key: local.data, loading: certs.isPending || local.isPending, certs };
}

/**
 * «Підписати ЕП». Internal УЕП: the browser signs the server's SHA-256 of the
 * served (sanitized) bytes with its non-extractable key, producing CAdES-BES.
 * With PAdES (ordinary PDFs) the server first stamps a copy with a visible QR
 * stamp and returns the digest of its byte ranges; the browser signs that
 * instead, and the signed copy can be downloaded.
 * КЕП: the detached .p7s produced by a certified tool (IIT / Дія.Підпис) is
 * uploaded and verified by the QES gateway with OCSP and TSP.
 */
export function SignDialog({
  fileId,
  open,
  onClose,
  onSigned,
  padesAllowed = false,
}: {
  fileId: string;
  open: boolean;
  onClose: () => void;
  onSigned?: (s: Signature) => void;
  /** An ordinary (not confidential) PDF: offer the stamped PAdES copy. */
  padesAllowed?: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'INTERNAL_PKI' | 'EXTERNAL_QES'>('INTERNAL_PKI');
  const [p7s, setP7s] = useState<Uint8Array | null>(null);
  const [format, setFormat] = useState<'PAdES' | 'CAdES'>(padesAllowed ? 'PAdES' : 'CAdES');
  const [error, setError] = useState<string | null>(null);
  const info = useQuery({ queryKey: ['signing-info', fileId], queryFn: () => api<SigningInfo>(`/files/${fileId}/signing-info`), enabled: open });
  const local = useLocalCertificate();

  const sign = useMutation({
    mutationFn: async () => {
      const i = info.data!;
      let signature: string;
      if (mode === 'INTERNAL_PKI') {
        if (!local.cert || !local.key) throw new Error('no-cert');
        const { signDigest, hexToBytes } = await import('@puet/signing');
        if (padesAllowed && format === 'PAdES') {
          const draft = await api<{ draftId: string; digest: string }>(`/files/${fileId}/pades`, { method: 'POST' });
          // PAdES: no signing-time attribute; the time is in the PDF's signature dictionary.
          const cms = await signDigest(hexToBytes(draft.digest), local.key.privateKey, local.cert.certificatePem, null);
          return api<Signature>(`/files/${fileId}/pades/${draft.draftId}`, { method: 'POST', body: { signature: cms } });
        }
        signature = await signDigest(hexToBytes(i.sha256), local.key.privateKey, local.cert.certificatePem);
      } else {
        if (!p7s) throw new Error('no-file');
        signature = toB64(p7s);
      }
      return api<Signature>(`/files/${fileId}/signatures`, { method: 'POST', body: { provider: mode, signature } });
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: keys.signatures(fileId) });
      void qc.invalidateQueries({ queryKey: keys.verification(fileId) });
      onSigned?.(s);
    },
    onError: (e) =>
      setError(
        e instanceof Error && e.message === 'no-cert'
          ? t('sign.noCertificate')
          : e instanceof ApiError && e.status === 503
            ? t('sign.qesUnavailable')
            : e instanceof ApiError && e.status === 422
              ? t('sign.rejected')
              : t('app.error'),
      ),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('sign.title')}
      footer={
        sign.isSuccess ? (
          <Button onClick={onClose}>{t('app.close')}</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('app.cancel')}
            </Button>
            <Button
              variant="accent"
              loading={sign.isPending}
              disabled={!info.data || (mode === 'INTERNAL_PKI' ? !local.cert : !p7s)}
              onClick={() => {
                setError(null);
                sign.mutate();
              }}
            >
              {sign.isPending ? t('sign.signing') : t('sign.confirm')}
            </Button>
          </>
        )
      }
    >
      {sign.isSuccess ? (
        <p className="flex items-center gap-2 body-5 text-success" role="status">
          <CheckCircle size={22} weight="fill" aria-hidden="true" />
          {t('sign.done')}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {error && <InlineError>{error}</InlineError>}
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t('sign.title')}</legend>
            {(['INTERNAL_PKI', 'EXTERNAL_QES'] as const).map((p) => {
              const available = p === 'INTERNAL_PKI' || !!info.data?.providers.EXTERNAL_QES;
              return (
                <label
                  key={p}
                  className={cx(
                    'flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors duration-300 ease-pulse',
                    mode === p ? 'border-primary bg-surface-2' : 'border-line',
                    !available && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <input type="radio" name="provider" className="mt-1 accent-[var(--puet-navy-primary)]" checked={mode === p} disabled={!available} onChange={() => setMode(p)} />
                  <span className="flex flex-col">
                    <span className="body-5">{p === 'INTERNAL_PKI' ? t('sign.internal') : t('sign.qes')}</span>
                    {p === 'EXTERNAL_QES' && !available && <span className="caption-5 text-muted">{t('sign.qesUnavailable')}</span>}
                  </span>
                </label>
              );
            })}
          </fieldset>

          {mode === 'INTERNAL_PKI' && padesAllowed && (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 caption-3 text-muted">{t('sign.format')}</legend>
              {(['PAdES', 'CAdES'] as const).map((f) => (
                <label key={f} className="flex cursor-pointer items-start gap-2 body-6">
                  <input type="radio" name="format" className="mt-1 accent-[var(--puet-navy-primary)]" checked={format === f} onChange={() => setFormat(f)} />
                  <span>{f === 'PAdES' ? t('sign.pades') : t('sign.cades')}</span>
                </label>
              ))}
            </fieldset>
          )}
          {mode === 'INTERNAL_PKI' && !local.loading && !local.cert && (
            <p className="flex items-start gap-2 body-6 text-muted">
              <CertIcon size={18} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
              <span>
                {t('sign.noCertificate')}{' '}
                <Link to="/settings#certificates" className="text-primary underline">
                  {t('nav.settings')}
                </Link>
              </span>
            </p>
          )}
          {mode === 'EXTERNAL_QES' && (
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-line px-4 py-3 body-6 hover:bg-surface-hover">
              <UploadSimple size={18} aria-hidden="true" />
              {p7s ? `.p7s · ${p7s.length} B` : '.p7s / .p7m'}
              <input type="file" accept=".p7s,.p7m,application/pkcs7-signature" className="sr-only" onChange={async (e) => setP7s(e.target.files?.[0] ? new Uint8Array(await e.target.files[0].arrayBuffer()) : null)} />
            </label>
          )}
          {info.data && !(mode === 'INTERNAL_PKI' && padesAllowed && format === 'PAdES') && (
            <div className="flex flex-col gap-1">
              <span className="caption-3 text-muted">{t('sign.digest')}</span>
              <code className="rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs leading-4 break-all">{info.data.sha256}</code>
            </div>
          )}
          {info.isError && <InlineError>{t('app.accessDenied')}</InlineError>}
          <p className="caption-5 text-muted">{t('sign.legal')}</p>
        </div>
      )}
    </Dialog>
  );
}
