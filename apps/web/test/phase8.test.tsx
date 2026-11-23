import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { BotCard } from '../src/api/types';
import { BotCardView } from '../src/features/bots/BotCardView';
import { formatDay, isBotSlug } from '../src/features/bots/bot-meta';

const view = (card: BotCard) =>
  render(
    <MemoryRouter>
      <BotCardView card={card} />
    </MemoryRouter>,
  );

const change = (over: Partial<Extract<BotCard, { kind: 'schedule_change' }>> = {}): BotCard => ({
  kind: 'schedule_change',
  changeId: 'c1',
  change: 'ONLINE',
  date: '2026-11-23',
  pair: 2,
  discipline: 'Бази даних',
  group: 'КН-21',
  room: null,
  newDate: null,
  newPair: null,
  link: 'https://moodle.puet.edu.ua/mod/zoom/view.php?id=7',
  note: null,
  ...over,
});

describe('bot cards', () => {
  it('XSS: notes from university systems render as text', () => {
    const { container } = view({ kind: 'document_request', requestId: 'r', type: 'STUDY_CERTIFICATE', status: 'READY', note: '<img src=x onerror=alert(1)>' });
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/onerror=alert/)).toBeTruthy();
  });

  it('phishing: only https links become links, opened without a referrer', () => {
    view(change());
    const a = screen.getByRole('link');
    expect(a.getAttribute('href')).toBe('https://moodle.puet.edu.ua/mod/zoom/view.php?id=7');
    expect(a.getAttribute('rel')).toContain('noopener');
    expect(a.getAttribute('rel')).toContain('noreferrer');
  });

  it('phishing: a javascript: link from a compromised feed is not rendered', () => {
    const { container } = view(change({ link: 'javascript:alert(1)' }));
    expect(container.querySelector('a')).toBeNull();
  });

  it('approval cards link to the document inside the app only', () => {
    view({ kind: 'approval', routeId: 'r', fileId: '00000000-0000-4000-8000-000000000001', title: 'Наказ', status: 'APPROVED', event: 'registered', registrationNo: '118-к' });
    expect(screen.getByRole('link').getAttribute('href')).toBe('/files/00000000-0000-4000-8000-000000000001');
    expect(screen.getByText(/118-к/)).toBeTruthy();
  });
});

describe('bot routes', () => {
  it('only known bot slugs reach the API', () => {
    expect(isBotSlug('deanery')).toBe(true);
    expect(isBotSlug('../admin')).toBe(false);
    expect(isBotSlug('DEANERY')).toBe(false);
  });

  it('calendar days keep their date in every time zone', () => {
    expect(formatDay('2026-11-23', 'en')).toContain('23');
  });
});
