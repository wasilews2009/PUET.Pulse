import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Channel, Message } from '../src/api/types';

vi.mock('../src/session/session', () => ({
  useMe: () => ({ userId: '00000000-0000-4000-8000-0000000000aa', roles: [] }),
}));
vi.mock('../src/api/queries', async (orig) => ({
  ...(await orig<typeof import('../src/api/queries')>()),
  useCard: () => ({ data: undefined }),
}));

const { Bubble } = await import('../src/features/chat/MessageList');

const channel = { id: '00000000-0000-4000-8000-000000000001', type: 'ACADEMIC_GROUP', e2eeMode: 'DISABLED', role: 'MEMBER', threadsRequired: false } as unknown as Channel;
const message = (body: string): Message => ({
  id: '00000000-0000-4000-8000-000000000002',
  channelId: channel.id,
  senderId: '00000000-0000-4000-8000-0000000000bb',
  senderDeviceId: null,
  threadRootId: null,
  scheme: 'PLAINTEXT',
  body,
  ciphertext: null,
  isPriority: false,
  createdAt: '2026-11-20T09:15:00.000Z',
  editedAt: null,
  expiresAt: null,
  deleted: false,
});

describe('message rendering', () => {
  it('XSS: message bodies are rendered as text, never as HTML', () => {
    const payload = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ol>
          <Bubble m={message(payload)} channel={channel} showAuthor />
        </ol>
      </QueryClientProvider>,
    );
    expect(screen.getByText(payload)).toBeInTheDocument();
    expect(container.querySelector('img[src="x"], script')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
