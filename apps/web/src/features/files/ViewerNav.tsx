import { BookmarkSimple, ListBullets, MagnifyingGlass, SquaresFour, Trash } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { Bookmark, OutlineEntry } from '../../api/types';
import { Button, cx, Input } from '../../components/ui';
import type { PdfDoc } from './pdf';
import { countMatches, snippetAround, type PageHit, type TextItemLike } from './search';

export type NavTab = 'pages' | 'outline' | 'bookmarks' | 'search';

/** Text of one page as PDF.js extracts it (never rendered as selectable text). */
export async function pageText(doc: PdfDoc, n: number): Promise<{ text: string; items: TextItemLike[] }> {
  const page = await doc.getPage(n);
  const content = await page.getTextContent();
  const items = content.items.filter((i): i is (typeof content.items)[number] & TextItemLike => 'str' in i);
  return { text: items.map((i) => i.str + ('hasEOL' in i && i.hasEOL ? ' ' : '')).join(''), items };
}

/** A page thumbnail, drawn only once it scrolls into view. */
function Thumb({ doc, n, active, onPick }: { doc: PdfDoc; n: number; active: boolean; onPick: () => void }) {
  const { t } = useTranslation();
  const box = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (visible || !box.current || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setVisible(true), { rootMargin: '200px' });
    io.observe(box.current);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    void doc.getPage(n).then((page) => {
      const c = canvas.current;
      if (cancelled || !c) return;
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 120 / base.width });
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d');
      if (!ctx) return;
      task = page.render({ canvas: c, canvasContext: ctx, viewport: vp, annotationMode: 0 });
      task.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, doc, n]);

  useEffect(() => {
    if (active) box.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  return (
    <button
      ref={box}
      type="button"
      onClick={onPick}
      aria-current={active ? 'page' : undefined}
      aria-label={t('viewer.goToPage', { page: n })}
      className={cx(
        'flex flex-col items-center gap-1 rounded-lg p-2 transition-colors duration-300 ease-pulse focus-visible:outline-2 focus-visible:outline-accent',
        active ? 'bg-white/15' : 'hover:bg-white/10',
      )}
    >
      <span className={cx('block min-h-20 w-[120px] bg-white', active && 'outline-2 outline-accent')}>
        <canvas ref={canvas} className="block w-full" onContextMenu={(e) => e.preventDefault()} />
      </span>
      <span className="caption-4 tabular-nums text-white/80">{n}</span>
    </button>
  );
}

function Outline({ entries, page, onPick }: { entries: OutlineEntry[]; page: number; onPick: (p: number) => void }) {
  const { t } = useTranslation();
  if (entries.length === 0) return <p className="p-3 body-6 text-white/70">{t('viewer.noOutline')}</p>;
  return (
    <ul className="flex flex-col p-2">
      {entries.map((e, i) => (
        <li key={i}>
          <button
            type="button"
            onClick={() => onPick(e.page)}
            style={{ paddingLeft: `${8 + Math.min(e.level, 6) * 12}px` }}
            className={cx(
              'flex w-full items-baseline justify-between gap-2 rounded-lg py-1 pr-2 text-left body-6 transition-colors duration-300 ease-pulse hover:bg-white/10',
              e.page === page && 'bg-white/10',
            )}
          >
            <span className="min-w-0 break-words">{e.title}</span>
            <span className="shrink-0 caption-5 tabular-nums text-white/60">{e.page}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function useBookmarks(fileId: string, enabled: boolean) {
  return useQuery({ queryKey: ['bookmarks', fileId], queryFn: () => api<Bookmark[]>(`/files/${fileId}/bookmarks`), enabled });
}

/** Adds or removes the bookmark on the current page. */
export function useToggleBookmark(fileId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ page, existing }: { page: number; existing: Bookmark | undefined }) =>
      existing
        ? api(`/files/${fileId}/bookmarks/${existing.id}`, { method: 'DELETE' })
        : api<Bookmark>(`/files/${fileId}/bookmarks`, { method: 'POST', body: { page } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['bookmarks', fileId] }),
  });
}

function Bookmarks({ fileId, page, onPick }: { fileId: string; page: number; onPick: (p: number) => void }) {
  const { t } = useTranslation();
  const list = useBookmarks(fileId, true);
  const toggle = useToggleBookmark(fileId);
  if (list.data?.length === 0) return <p className="p-3 body-6 text-white/70">{t('viewer.noBookmarks')}</p>;
  return (
    <ul className="flex flex-col gap-1 p-2">
      {list.data?.map((b) => (
        <li key={b.id} className={cx('flex items-center gap-1 rounded-lg', b.page === page && 'bg-white/10')}>
          <button type="button" onClick={() => onPick(b.page)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-left body-6 hover:bg-white/10">
            <BookmarkSimple size={16} weight="fill" className="shrink-0 text-accent" aria-hidden="true" />
            <span className="truncate">{b.label ?? t('viewer.pageShort', { page: b.page })}</span>
          </button>
          <button
            type="button"
            aria-label={t('viewer.removeBookmark', { page: b.page })}
            onClick={() => toggle.mutate({ page: b.page, existing: b })}
            className="rounded-lg p-1 text-white/60 hover:bg-white/10 hover:text-white"
          >
            <Trash size={16} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Full-text search over the document's pages. Runs in the browser on the text
 * PDF.js extracts (the server never indexes viewed documents). For
 * confidential files only page numbers are listed: the excerpt would let a
 * view-only document be copied out as text.
 */
function Search({
  doc,
  total,
  confidential,
  query,
  onQuery,
  onPick,
}: {
  doc: PdfDoc;
  total: number;
  confidential: boolean;
  query: string;
  onQuery: (q: string) => void;
  onPick: (p: number) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(query);
  const [hits, setHits] = useState<PageHit[] | null>(null);
  const [scanned, setScanned] = useState(0);
  const run = useRef(0);

  useEffect(() => {
    const id = ++run.current;
    if (query.trim().length < 2) {
      setHits(null);
      return;
    }
    setHits([]);
    setScanned(0);
    void (async () => {
      const found: PageHit[] = [];
      for (let n = 1; n <= total; n++) {
        if (run.current !== id) return;
        try {
          const { text } = await pageText(doc, n);
          const count = countMatches(text, query);
          if (count > 0) {
            const snippet = confidential ? undefined : snippetAround(text, query);
            found.push({ page: n, count, ...(snippet ? { snippet } : {}) });
            if (run.current === id) setHits([...found]);
          }
        } catch {
          /* a page without text */
        }
        if (run.current === id) setScanned(n);
      }
    })();
    return () => {
      run.current++;
    };
  }, [doc, total, query, confidential]);

  const done = scanned >= total;
  const matches = hits?.reduce((a, h) => a + h.count, 0) ?? 0;
  return (
    <div className="flex flex-col gap-2 p-2">
      <form
        role="search"
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onQuery(draft);
        }}
      >
        <Input
          type="search"
          value={draft}
          maxLength={100}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={t('viewer.searchLabel')}
          placeholder={t('viewer.searchLabel')}
          className="min-w-0 flex-1"
        />
        <Button type="submit" size="sm" variant="accent" icon={<MagnifyingGlass size={16} />}>
          {t('viewer.find')}
        </Button>
      </form>
      {hits && (
        <p className="caption-5 text-white/70" aria-live="polite">
          {done ? t('viewer.searchDone', { count: matches, pages: hits.length }) : t('viewer.searching', { page: scanned, total })}
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {hits?.map((h) => (
          <li key={h.page}>
            <button type="button" onClick={() => onPick(h.page)} className="flex w-full flex-col gap-1 rounded-lg px-2 py-1 text-left hover:bg-white/10">
              <span className="caption-4 text-white/80">
                {t('viewer.pageShort', { page: h.page })} · {t('viewer.matches', { count: h.count })}
              </span>
              {h.snippet && <span className="body-6 break-words">{h.snippet}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Left navigation of the Secure Viewer: thumbnails, table of contents, bookmarks, search. */
export function ViewerNav({
  doc,
  fileId,
  total,
  page,
  onPick,
  outline,
  confidential,
  tab,
  onTab,
  query,
  onQuery,
}: {
  doc: PdfDoc;
  fileId: string;
  total: number;
  page: number;
  onPick: (p: number) => void;
  outline: OutlineEntry[];
  confidential: boolean;
  tab: NavTab;
  onTab: (t: NavTab) => void;
  query: string;
  onQuery: (q: string) => void;
}) {
  const { t } = useTranslation();
  const tabs: { key: NavTab; label: string; icon: typeof SquaresFour }[] = [
    { key: 'pages', label: t('viewer.thumbnails'), icon: SquaresFour },
    { key: 'outline', label: t('viewer.outline'), icon: ListBullets },
    { key: 'bookmarks', label: t('viewer.bookmarks'), icon: BookmarkSimple },
    { key: 'search', label: t('viewer.search'), icon: MagnifyingGlass },
  ];
  return (
    <nav aria-label={t('viewer.navigation')} className="flex h-full min-h-0 flex-col bg-[#121619] text-white">
      <div role="tablist" className="grid grid-cols-4 gap-1 border-b border-white/10 p-2">
        {tabs.map((x) => (
          <button
            key={x.key}
            role="tab"
            type="button"
            aria-selected={tab === x.key}
            aria-label={x.label}
            title={x.label}
            onClick={() => onTab(x.key)}
            className={cx(
              'flex items-center justify-center rounded-lg py-2 transition-colors duration-300 ease-pulse focus-visible:outline-2 focus-visible:outline-accent',
              tab === x.key ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10',
            )}
          >
            <x.icon size={20} weight={tab === x.key ? 'fill' : 'regular'} aria-hidden="true" />
          </button>
        ))}
      </div>
      <p className="px-3 pt-2 caption-3 text-white/70">{tabs.find((x) => x.key === tab)!.label}</p>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'pages' && (
          <div className="flex flex-col items-center gap-1 p-2">
            {Array.from({ length: total }, (_, i) => (
              <Thumb key={i + 1} doc={doc} n={i + 1} active={page === i + 1} onPick={() => onPick(i + 1)} />
            ))}
          </div>
        )}
        {tab === 'outline' && <Outline entries={outline} page={page} onPick={onPick} />}
        {tab === 'bookmarks' && <Bookmarks fileId={fileId} page={page} onPick={onPick} />}
        {tab === 'search' && <Search doc={doc} total={total} confidential={confidential} query={query} onQuery={onQuery} onPick={onPick} />}
      </div>
    </nav>
  );
}
