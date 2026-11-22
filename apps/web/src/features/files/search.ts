/** Plain-text search over PDF pages (PDF.js text content), shared by the viewer and its tests. */

export interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

export interface PageHit {
  page: number;
  count: number;
  /** Text around the first match; omitted for confidential files (view-only, no copying). */
  snippet?: string;
}

/** Case- and accent-insensitive form; Ukrainian apostrophes are unified. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’ʼ‘`]/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function countMatches(haystack: string, query: string): number {
  const q = normalize(query).trim();
  if (q.length < 2) return 0;
  const h = normalize(haystack);
  let n = 0;
  for (let i = h.indexOf(q); i !== -1; i = h.indexOf(q, i + q.length)) n++;
  return n;
}

/** A short excerpt around the first match, built only from the page's text. */
export function snippetAround(text: string, query: string, radius = 40): string | undefined {
  const flat = text.replace(/\s+/g, ' ');
  const i = normalize(flat).indexOf(normalize(query).trim());
  if (i < 0) return undefined;
  const start = Math.max(0, i - radius);
  const end = Math.min(flat.length, i + query.trim().length + radius);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

/**
 * Relative rectangles (0..1, top-left origin) of the text items that contain the
 * query, so the viewer can outline them on the canvas.
 */
export function matchRects(items: TextItemLike[], query: string, pageWidth: number, pageHeight: number) {
  const q = normalize(query).trim();
  if (q.length < 2 || pageWidth <= 0 || pageHeight <= 0) return [];
  return items
    .filter((it) => normalize(it.str).includes(q))
    .map((it) => {
      const [, , , d = 0, e = 0, f = 0] = it.transform;
      const h = Math.abs(it.height || d);
      return {
        x: Math.max(0, e / pageWidth),
        y: Math.max(0, 1 - (f + h) / pageHeight),
        w: Math.min(1, it.width / pageWidth),
        h: Math.min(1, (h * 1.2) / pageHeight),
      };
    });
}
