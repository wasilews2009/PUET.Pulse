import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PdfDoc } from '../src/features/files/pdf';
import { countMatches, matchRects, normalize, snippetAround } from '../src/features/files/search';
import { ViewerNav, type NavTab } from '../src/features/files/ViewerNav';

// jsdom has no canvas; thumbnails simply skip drawing.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const pages = ['Кошторис ПУЕТ на 2027 рік', 'Розділ 2. Видатки на обладнання', 'Додаток: обладнання для лабораторій'];

/** Just enough of a PDF.js document for the navigation panel. */
const fakeDoc = {
  numPages: pages.length,
  getPage: async (n: number) => ({
    getTextContent: async () => ({ items: [{ str: pages[n - 1]!, transform: [12, 0, 0, 12, 50, 780], width: 200, height: 12, hasEOL: true }] }),
    getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
  }),
} as unknown as PdfDoc;

function nav(tab: NavTab, confidential = false, outline = [{ title: '<img src=x onerror=alert(1)>', page: 2, level: 0 }]) {
  let picked = 0;
  let query = '';
  const props = {
    doc: fakeDoc,
    fileId: '00000000-0000-4000-8000-000000000001',
    total: pages.length,
    page: 1,
    onPick: (p: number) => (picked = p),
    outline,
    confidential,
    tab,
    onTab: () => undefined,
    query,
    onQuery: (q: string) => (query = q),
  };
  const utils = render(<ViewerNav {...props} />);
  return {
    ...utils,
    picked: () => picked,
    search: (q: string) => {
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: q } });
      fireEvent.submit(screen.getByRole('search'));
      utils.rerender(<ViewerNav {...props} query={query} />);
    },
  };
}

describe('viewer search helpers', () => {
  it('matches ignore case, accents and apostrophe variants', () => {
    expect(normalize('М’ЯСО')).toBe("м'ясо");
    expect(countMatches('Обладнання, обладнання та ОБЛАДНАННЯ', 'обладнання')).toBe(3);
    expect(countMatches('anything', 'a')).toBe(0); // one letter is not a search
    expect(snippetAround('x'.repeat(100) + ' Видатки на обладнання ' + 'y'.repeat(100), 'видатки')).toMatch(/^….*Видатки.*…$/);
  });

  it('match rectangles are relative to the page and outline the text item', () => {
    const [r] = matchRects([{ str: 'Видатки', transform: [12, 0, 0, 12, 59.5, 421], width: 119, height: 12 }], 'видатки', 595, 842);
    expect(r!.x).toBeCloseTo(0.1);
    expect(r!.w).toBeCloseTo(0.2);
    expect(r!.y).toBeCloseTo(1 - 433 / 842);
  });
});

describe('Secure Viewer navigation', () => {
  it('XSS: outline titles from the document render as text', () => {
    const { container, picked } = nav('outline');
    expect(container.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByText(/onerror=alert/));
    expect(picked()).toBe(2);
  });

  it('full-text search lists pages with excerpts', async () => {
    const v = nav('search');
    v.search('обладнання');
    await waitFor(() => expect(screen.getByText(/Знайдено 2 збіги/)).toBeTruthy());
    expect(screen.getByText(/Видатки на обладнання/)).toBeTruthy();
  });

  it('DLP: search in a confidential document lists page numbers but never its text', async () => {
    const v = nav('search', true);
    v.search('обладнання');
    await waitFor(() => expect(screen.getByText(/Знайдено 2 збіги/)).toBeTruthy());
    expect(screen.queryByText(/Видатки на обладнання/)).toBeNull();
    expect(screen.getAllByText(/Стор\. \d/)).toHaveLength(2);
  });

  it('thumbnails: one per page, the current one marked', () => {
    nav('pages');
    const thumbs = screen.getAllByRole('button', { name: /Перейти до сторінки/ });
    expect(thumbs).toHaveLength(3);
    expect(thumbs[0]!.getAttribute('aria-current')).toBe('page');
  });
});
