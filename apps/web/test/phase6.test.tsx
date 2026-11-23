import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Channel, Poll } from '../src/api/types';
import { parseMessage } from '../src/features/chat/format';

const ME = '00000000-0000-4000-8000-0000000000aa';
let pollData: Poll;

vi.mock('../src/session/session', () => ({ useMe: () => ({ userId: ME, roles: [] }) }));
vi.mock('../src/api/queries', async (orig) => ({
  ...(await orig<typeof import('../src/api/queries')>()),
  useCard: () => ({ data: undefined }),
  usePoll: () => ({ isPending: false, isError: false, data: pollData }),
}));

const { MessageBody } = await import('../src/features/chat/MessageBody');
const { PollCard } = await import('../src/features/polls/PollCard');
const { renderMath } = await import('../src/features/chat/math');

const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

const channel = {
  id: '00000000-0000-4000-8000-000000000001',
  type: 'GOVERNANCE',
  e2eeMode: 'DISABLED',
  role: 'MEMBER',
  archived: false,
  threadsRequired: false,
} as unknown as Channel;

const basePoll = (over: Partial<Poll> = {}): Poll => ({
  id: '00000000-0000-4000-8000-000000000003',
  channelId: channel.id,
  messageId: '00000000-0000-4000-8000-000000000004',
  createdById: '00000000-0000-4000-8000-0000000000bb',
  question: 'Про затвердження плану <img src=x onerror=alert(1)>',
  options: ['FOR', 'AGAINST', 'ABSTAIN'],
  mode: 'SECRET',
  multipleChoice: false,
  formal: true,
  quorum: 19,
  eligibleCount: 37,
  status: 'OPEN',
  closesAt: null,
  closedAt: null,
  createdAt: '2026-11-22T09:00:00.000Z',
  participants: 12,
  counts: null,
  voters: null,
  me: { voted: true, eligible: true, options: null },
  quorumReached: false,
  adopted: null,
  ...over,
});

describe('message formatting', () => {
  it('splits code blocks, inline code and formulas, and leaves prices alone', () => {
    const segs = parseMessage('Ціна 50$ і 70$. ```ts\nconst a = 1;\n``` далі `x` та \\(a^2\\) і $$\\int_0^1 x\\,dx$$');
    expect(segs.map((s) => s.kind)).toEqual(['text', 'block', 'text', 'code', 'text', 'math', 'text', 'math']);
    expect(segs[0]).toEqual({ kind: 'text', text: 'Ціна 50$ і 70$. ' });
    expect(segs[1]).toEqual({ kind: 'block', lang: 'ts', text: 'const a = 1;' });
    expect(segs[5]).toEqual({ kind: 'math', tex: 'a^2', display: false });
    expect(segs[7]).toMatchObject({ kind: 'math', display: true });
  });

  it('XSS: code blocks and inline code render HTML as text', async () => {
    const payload = '<img src=x onerror="window.__pwned=1">';
    const { container } = wrap(<MessageBody text={'```html\n' + payload + '\n```\n`<script>window.__pwned=1</script>`'} />);
    // Wait for the lazily loaded highlighter to replace the plain text.
    await waitFor(() => expect(container.querySelector('pre code span')).not.toBeNull());
    expect(container.querySelector('img, script')).toBeNull();
    expect(container.textContent).toContain(payload);
    // Highlighting produced only spans with hljs classes.
    for (const el of container.querySelectorAll('pre code *')) {
      expect(el.tagName).toBe('SPAN');
      expect(el.getAttribute('class') ?? '').toMatch(/^(hljs-[a-z_-]+ ?)*$/);
    }
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('XSS: formulas cannot create links, scripts or inline handlers (trust is off)', () => {
    const el = document.createElement('span');
    renderMath(el, '\\href{javascript:alert(1)}{x} \\url{javascript:alert(2)} \\htmlId{a}{b} x^2', false);
    expect(el.querySelector('a, script, [onclick], [onerror]')).toBeNull();
    // The TeX source may appear as text (MathML annotation), never in an attribute.
    for (const node of el.querySelectorAll('*')) {
      for (const a of node.attributes) expect(a.value.toLowerCase()).not.toContain('javascript:');
    }
  });
});

describe('poll card', () => {
  it('secret ballot: no results before closing, only the turnout and quorum', () => {
    pollData = basePoll();
    const { container } = wrap(<PollCard pollId={pollData.id} channel={channel} />);
    expect(screen.getByText(/Результати таємного голосування/)).toBeInTheDocument();
    expect(screen.getByText(/Проголосували 12 з 37 · кворум 19/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Проголосувати' })).toBeNull();
    // The question is text, never markup.
    expect(container.querySelector('img')).toBeNull();
    // A member who is not the author or a moderator cannot close it.
    expect(screen.queryByRole('button', { name: 'Завершити' })).toBeNull();
  });

  it('formal answers are localized and the protocol is offered after closing', async () => {
    pollData = basePoll({ status: 'CLOSED', counts: [27, 1, 3], participants: 31, quorumReached: true, adopted: true, closedAt: '2026-11-22T09:40:00.000Z' });
    wrap(<PollCard pollId={pollData.id} channel={channel} />);
    for (const label of ['За', 'Проти', 'Утримався']) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText('Рішення прийнято')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('link', { name: /Протокол PDF/ })).toHaveAttribute('href', `/api/polls/${pollData.id}/protocol.pdf?lang=uk`));
  });

  it('an eligible member who has not voted gets the ballot; a late joiner does not', () => {
    pollData = basePoll({ me: { voted: false, eligible: true, options: null } });
    const first = wrap(<PollCard pollId={pollData.id} channel={channel} />);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    first.unmount();
    pollData = basePoll({ me: { voted: false, eligible: false, options: null } });
    wrap(<PollCard pollId={pollData.id} channel={channel} />);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByText(/Вас немає в списку/)).toBeInTheDocument();
  });
});
