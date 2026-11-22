import { ArrowLeft, BookmarkSimple, CaretLeft, CaretRight, Highlighter, SidebarSimple, Lock, MagnifyingGlassMinus, MagnifyingGlassPlus, NotePencil, PenNib, ShieldCheck, Stamp, Trash } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, isUuid } from '../../api/client';
import { keys, useCard } from '../../api/queries';
import type { Annotation, FileItem, Rect, Signature } from '../../api/types';
import { Badge, Button, cx, EmptyState, IconButton, InlineError, Skeleton, TextArea, Toggle, formatDateTime } from '../../components/ui';
import { pick } from '../../i18n';
import { NotFoundPage } from '../../pages/NotFoundPage';
import { useMe } from '../../session/session';
import { NewRouteDialog, RouteView, useRoutes } from '../approvals/RoutePanel';
import { SignDialog } from '../signatures/SignDialog';
import { SignedBadge } from '../signatures/Protocol';
import { openPdf, openPdfStream, type PdfDoc } from './pdf';
import { matchRects } from './search';
import { pageText, useBookmarks, useToggleBookmark, ViewerNav, type NavTab } from './ViewerNav';
import { PdfPage } from './PdfPage';
import { useFileBytes } from './useFileBytes';

function AnnotationItem({ fileId, a, active, onSelect }: { fileId: string; a: Annotation; active: boolean; onSelect: () => void }) {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const mine = a.authorId === me.userId;
  const author = useCard(mine ? null : a.authorId);
  const del = useMutation({
    mutationFn: () => api(`/files/${fileId}/annotations/${a.id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['annotations', fileId] }),
  });
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cx('flex w-full flex-col gap-1 rounded-xl border px-3 py-2 text-left transition-colors duration-300 ease-pulse', active ? 'border-accent bg-surface-2' : 'border-line hover:bg-surface-hover')}
      >
        <span className="flex items-center justify-between gap-2 caption-4 text-muted">
          <span>
            {t('viewer.pageShort', { page: a.page })}
            {mine ? '' : ` · ${author.data ? pick(i18n.language, author.data.fullNameUk, author.data.fullNameEn) : t('chats.hiddenUser')}`}
          </span>
          <Badge tone={a.visibility === 'SHARED' ? 'navy' : 'neutral'}>{a.visibility === 'SHARED' ? t('viewer.shared') : t('viewer.private')}</Badge>
        </span>
        {a.text && <span className="body-6 whitespace-pre-wrap">{a.text}</span>}
        <span className="caption-5 text-muted">{formatDateTime(a.createdAt, i18n.language)}</span>
      </button>
      {mine && (
        <button type="button" onClick={() => del.mutate()} className="mt-1 inline-flex items-center gap-1 caption-4 text-muted hover:text-danger">
          <Trash size={14} aria-hidden="true" />
          {t('app.delete')}
        </button>
      )}
    </li>
  );
}

/**
 * Secure PDF Viewer. Only the sanitized copy is served; confidential files come
 * watermarked with the viewer's name, corporate id and time, cannot be
 * downloaded (the policy engine denies it), copied (canvas only, no text layer)
 * or printed from here.
 */
export default function ViewerPage() {
  const { fileId } = useParams();
  if (!isUuid(fileId)) return <NotFoundPage />;
  return <Viewer key={fileId} fileId={fileId} />;
}

function Viewer({ fileId }: { fileId: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const me = useMe();
  const qc = useQueryClient();
  const meta = useQuery({ queryKey: keys.file(fileId), queryFn: () => api<FileItem>(`/files/${fileId}`), retry: false });
  const isPdf = meta.data?.mimeType === 'application/pdf';
  const confidential = meta.data?.confidential === true;
  const ready = !!meta.data && meta.data.status === 'READY' && meta.data.viewable;
  // Ordinary PDFs stream page by page (range requests); watermarked copies and images come whole.
  const streamed = ready && isPdf && !confidential;
  const bytes = useFileBytes(fileId, ready && !streamed);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [docError, setDocError] = useState(false);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.25);
  const [panel, setPanel] = useState<'notes' | 'signatures' | 'route'>('notes');
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [noteText, setNoteText] = useState('');
  const [shared, setShared] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [signOpen, setSignOpen] = useState(false);
  const [routeOpen, setRouteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(min-width: 1024px)').matches);
  const [navTab, setNavTab] = useState<NavTab>('pages');
  const [query, setQuery] = useState('');
  const [marks, setMarks] = useState<Rect[]>([]);
  const bookmarks = useBookmarks(fileId, isPdf);
  const toggleBookmark = useToggleBookmark(fileId);

  const annotations = useQuery({ queryKey: ['annotations', fileId], queryFn: () => api<Annotation[]>(`/files/${fileId}/annotations`), enabled: isPdf });
  const signatures = useQuery({ queryKey: keys.signatures(fileId), queryFn: () => api<Signature[]>(`/files/${fileId}/signatures`), enabled: !!meta.data });
  const routes = useRoutes(fileId);
  // Signing is offered only when the policy engine allows it for this caller (member or approver).
  const canSign = useQuery({
    queryKey: ['signing-info', fileId],
    queryFn: () => api<{ sha256: string }>(`/files/${fileId}/signing-info`),
    enabled: meta.data?.status === 'READY',
    retry: false,
  });

  useEffect(() => {
    if (!isPdf || !ready || (!streamed && !bytes.data)) return;
    let alive = true;
    let opened: PdfDoc | null = null;
    // pdf.js transfers the buffer to its worker, so hand it a copy.
    (streamed ? openPdfStream(fileId) : openPdf(bytes.data!.bytes.slice()))
      .then((d) => {
        opened = d;
        if (alive) setDoc(d);
        else void d.destroy();
      })
      .catch(() => alive && setDocError(true));
    return () => {
      alive = false;
      void opened?.destroy();
    };
  }, [bytes.data, isPdf, ready, streamed, fileId]);

  // Outline the search matches on the page on screen.
  useEffect(() => {
    if (!doc || query.trim().length < 2) {
      setMarks([]);
      return;
    }
    let alive = true;
    void Promise.all([pageText(doc, page), doc.getPage(page)])
      .then(([{ items }, p]) => {
        const vp = p.getViewport({ scale: 1 });
        if (alive) setMarks(matchRects(items, query, vp.width, vp.height));
      })
      .catch(() => alive && setMarks([]));
    return () => {
      alive = false;
    };
  }, [doc, page, query]);

  const imageUrl = useMemo(() => {
    if (!bytes.data || isPdf || !bytes.data.type.startsWith('image/')) return null;
    return URL.createObjectURL(new Blob([bytes.data.bytes.slice().buffer as ArrayBuffer], { type: bytes.data.type }));
  }, [bytes.data, isPdf]);
  useEffect(() => () => void (imageUrl && URL.revokeObjectURL(imageUrl)), [imageUrl]);

  const create = useMutation({
    mutationFn: () =>
      api<Annotation>(`/files/${fileId}/annotations`, {
        method: 'POST',
        body: { page, kind: noteText.trim() ? 'comment' : 'highlight', rects: [draft!], visibility: shared ? 'SHARED' : 'PRIVATE', color: 'yellow', ...(noteText.trim() ? { text: noteText.trim() } : {}) },
      }),
    onSuccess: (a) => {
      setDraft(null);
      setNoteText('');
      setDrawing(false);
      setActiveId(a.id);
      void qc.invalidateQueries({ queryKey: ['annotations', fileId] });
    },
  });

  if (meta.isError) {
    return meta.error instanceof ApiError && (meta.error.status === 403 || meta.error.status === 404) ? (
      <main id="main" className="flex flex-1 items-center justify-center">
        <EmptyState icon={<Lock size={28} />} title={t('app.accessDenied')} />
      </main>
    ) : (
      <div className="p-6">
        <InlineError>{t('app.error')}</InlineError>
      </div>
    );
  }

  const f = meta.data;
  const total = doc?.numPages ?? f?.pageCount ?? 1;
  const pageAnnotations = (annotations.data ?? []).filter((a) => a.page === page);
  const pendingRoute = routes.data?.find((r) => r.status === 'PENDING');
  const back = f?.channelId ? `/chats/${f.channelId}?tab=files` : '/chats';
  const bookmarkHere = bookmarks.data?.find((b) => b.page === page);
  const goTo = (p: number) => {
    setPage(Math.min(Math.max(1, p), total));
    if (typeof window !== 'undefined' && !window.matchMedia?.('(min-width: 1024px)').matches) setNavOpen(false);
  };

  return (
    <main id="main" className={cx('flex min-h-0 flex-1 flex-col bg-viewer text-white lg:flex-row', f?.confidential && 'pulse-no-copy pulse-no-print')}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-[#121619] px-2 py-2 md:px-4">
          <IconButton label={t('app.back')} className="text-white hover:bg-white/10 hover:text-white" onClick={() => navigate(back)}>
            <ArrowLeft size={22} />
          </IconButton>
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="truncate title-3">{f?.fileName ?? <Skeleton className="h-5 w-48" />}</h1>
            <p className="flex flex-wrap items-center gap-2 caption-5 text-white/70">
              <span className="inline-flex items-center gap-1">
                <ShieldCheck size={14} aria-hidden="true" />
                {t('viewer.sanitized')}
              </span>
              {f?.confidential && (
                <Badge tone="accent">
                  <Lock size={12} aria-hidden="true" />
                  {t('viewer.watermarked')}
                </Badge>
              )}
            </p>
          </div>
          <SignedBadge fileId={fileId} count={signatures.data?.length ?? 0} />
          {canSign.isSuccess && (
            <Button variant="accent" size="sm" icon={<PenNib size={18} />} onClick={() => setSignOpen(true)}>
              {t('viewer.sign')}
            </Button>
          )}
          {f && f.uploaderId === me.userId && !pendingRoute && isPdf && (
            <Button variant="secondary" size="sm" icon={<Stamp size={18} />} onClick={() => setRouteOpen(true)}>
              {t('approvals.start')}
            </Button>
          )}
        </header>

        {isPdf && doc && (
          <div className="flex flex-wrap items-center justify-center gap-1 border-b border-white/10 bg-[#121619] px-2 py-1">
            <IconButton
              label={t('viewer.navigation')}
              aria-pressed={navOpen}
              className={cx('text-white hover:bg-white/10 hover:text-white', navOpen && 'bg-white/15')}
              onClick={() => setNavOpen((v) => !v)}
            >
              <SidebarSimple size={20} />
            </IconButton>
            <IconButton
              label={bookmarkHere ? t('viewer.removeBookmark', { page }) : t('viewer.addBookmark', { page })}
              aria-pressed={!!bookmarkHere}
              className="text-white hover:bg-white/10 hover:text-white"
              disabled={toggleBookmark.isPending}
              onClick={() => toggleBookmark.mutate({ page, existing: bookmarkHere })}
            >
              <BookmarkSimple size={20} weight={bookmarkHere ? 'fill' : 'regular'} className={bookmarkHere ? 'text-accent' : undefined} />
            </IconButton>
            <span className="mx-1 h-6 w-px bg-white/10" aria-hidden="true" />
            <IconButton label={t('viewer.prev')} className="text-white hover:bg-white/10 hover:text-white" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <CaretLeft size={20} />
            </IconButton>
            <span className="caption-4 tabular-nums" aria-live="polite">
              {t('viewer.page', { page, total })}
            </span>
            <IconButton label={t('viewer.next')} className="text-white hover:bg-white/10 hover:text-white" disabled={page >= total} onClick={() => setPage((p) => p + 1)}>
              <CaretRight size={20} />
            </IconButton>
            <span className="mx-2 h-6 w-px bg-white/10" aria-hidden="true" />
            <IconButton label={t('viewer.zoomOut')} className="text-white hover:bg-white/10 hover:text-white" disabled={scale <= 0.5} onClick={() => setScale((s) => Math.max(0.5, s - 0.25))}>
              <MagnifyingGlassMinus size={20} />
            </IconButton>
            <span className="w-12 text-center caption-4 tabular-nums">{Math.round(scale * 100)}%</span>
            <IconButton label={t('viewer.zoomIn')} className="text-white hover:bg-white/10 hover:text-white" disabled={scale >= 3} onClick={() => setScale((s) => Math.min(3, s + 0.25))}>
              <MagnifyingGlassPlus size={20} />
            </IconButton>
            <span className="mx-2 h-6 w-px bg-white/10" aria-hidden="true" />
            <Button
              size="sm"
              variant={drawing ? 'accent' : 'ghost'}
              className={drawing ? '' : 'text-white hover:bg-white/10'}
              aria-pressed={drawing}
              icon={<Highlighter size={18} />}
              onClick={() => {
                setDrawing((v) => !v);
                setPanel('notes');
              }}
            >
              {t('viewer.highlight')}
            </Button>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {isPdf && doc && navOpen && (
          <div className="max-h-[40vh] min-h-0 shrink-0 border-b border-white/10 lg:max-h-none lg:w-64 lg:border-r lg:border-b-0">
            <ViewerNav
              doc={doc}
              fileId={fileId}
              total={total}
              page={page}
              onPick={goTo}
              outline={f?.outline ?? []}
              confidential={confidential}
              tab={navTab}
              onTab={setNavTab}
              query={query}
              onQuery={setQuery}
            />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto p-4 md:p-8">
          {(meta.isPending || (bytes.isPending && !streamed) || (streamed && !doc && !docError)) && f?.viewable !== false && <Skeleton className="mx-auto h-[70vh] w-full max-w-2xl rounded-none bg-white/10" />}
          {f && f.status !== 'READY' && <EmptyState icon={<ShieldCheck size={28} />} title={t(`files.status.${f.status}`)} />}
          {f && f.status === 'READY' && !f.viewable && (
            <EmptyState
              icon={<Lock size={28} />}
              title={t('viewer.notViewable')}
              action={
                <Link to={back} className="rounded-lg bg-primary px-3 py-2 button-md text-on-primary">
                  {t('app.back')}
                </Link>
              }
            />
          )}
          {(bytes.isError || docError) && <InlineError>{t('app.error')}</InlineError>}
          {doc && (
            <PdfPage
              doc={doc}
              pageNumber={page}
              scale={scale}
              annotations={pageAnnotations}
              drawing={drawing}
              onDraw={(r) => setDraft(r)}
              activeId={activeId}
              onSelect={(id) => {
                setActiveId(id);
                setPanel('notes');
              }}
              label={t('viewer.page', { page, total })}
              marks={marks}
            />
          )}
          {imageUrl && <img src={imageUrl} alt={f?.fileName ?? ''} className="mx-auto max-h-full max-w-full bg-white shadow-2xl" draggable={false} onContextMenu={(e) => e.preventDefault()} />}
          {bytes.data && !isPdf && bytes.data.type.startsWith('text/') && (
            <pre className="mx-auto max-w-3xl rounded-xl bg-white p-6 font-mono text-sm leading-5 whitespace-pre-wrap text-black">{new TextDecoder().decode(bytes.data.bytes)}</pre>
          )}
        </div>
        </div>
      </div>

      <aside aria-label={t('viewer.annotations')} className="flex max-h-[45vh] min-h-0 shrink-0 flex-col border-white/10 bg-surface text-ink lg:max-h-none lg:w-96 lg:border-l">
        <div role="tablist" className="flex gap-1 border-b border-line p-2">
          {(['notes', 'signatures', 'route'] as const).map((k) => (
            <button
              key={k}
              role="tab"
              type="button"
              aria-selected={panel === k}
              onClick={() => setPanel(k)}
              className={cx('flex-1 rounded-lg px-2 py-1 button-sm transition-colors duration-300 ease-pulse', panel === k ? 'bg-primary text-on-primary' : 'text-muted hover:bg-surface-hover')}
            >
              {k === 'notes' ? t('viewer.annotations') : k === 'signatures' ? t('viewer.signatures') : t('viewer.routeTab')}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {panel === 'notes' && (
            <div className="flex flex-col gap-3">
              {draft && (
                <div className="flex flex-col gap-2 rounded-xl border border-accent p-3">
                  <p className="title-4">{t('viewer.addNote')}</p>
                  <TextArea rows={3} aria-label={t('viewer.noteText')} placeholder={t('viewer.noteText')} maxLength={4000} value={noteText} onChange={(e) => setNoteText(e.target.value)} />
                  <Toggle checked={shared} onChange={setShared} label={t('viewer.shared')} />
                  <div className="flex gap-2">
                    <Button size="sm" variant="accent" loading={create.isPending} icon={<NotePencil size={16} />} onClick={() => create.mutate()}>
                      {t('app.save')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setDraft(null)}>
                      {t('app.cancel')}
                    </Button>
                  </div>
                </div>
              )}
              {annotations.data?.length === 0 && !draft && <p className="body-6 text-muted">{t('viewer.noAnnotations')}</p>}
              <ul className="flex flex-col gap-2">
                {annotations.data?.map((a) => (
                  <AnnotationItem
                    key={a.id}
                    fileId={fileId}
                    a={a}
                    active={a.id === activeId}
                    onSelect={() => {
                      setActiveId(a.id);
                      setPage(a.page);
                    }}
                  />
                ))}
              </ul>
            </div>
          )}
          {panel === 'signatures' && (
            <ul className="flex flex-col gap-2">
              {signatures.data?.length === 0 && <p className="body-6 text-muted">{t('verification.none')}</p>}
              {signatures.data?.map((s) => (
                <li key={s.id} className="flex flex-col gap-1 rounded-xl border border-line px-3 py-2">
                  <span className="flex items-center justify-between gap-2">
                    <span className="body-5">{s.signerName}</span>
                    <Badge tone={s.level === 'КЕП' ? 'navy' : 'neutral'}>{s.level}</Badge>
                  </span>
                  <span className="caption-5 text-muted">{formatDateTime(s.createdAt, i18n.language)}</span>
                </li>
              ))}
            </ul>
          )}
          {panel === 'route' && (
            <div className="flex flex-col gap-2">
              {routes.data?.length === 0 && <p className="body-6 text-muted">{t('approvals.empty')}</p>}
              {routes.data?.map((r) => (
                <RouteView key={r.id} route={r} />
              ))}
            </div>
          )}
        </div>
      </aside>

      <SignDialog fileId={fileId} open={signOpen} onClose={() => setSignOpen(false)} />
      <NewRouteDialog fileId={fileId} open={routeOpen} onClose={() => setRouteOpen(false)} />
    </main>
  );
}
