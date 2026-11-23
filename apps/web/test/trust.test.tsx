import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrustCase } from '../src/api/types';

const PSEUDONYM = '00000000-0000-4000-8000-0000000000a1';
const CHANNEL = '00000000-0000-4000-8000-0000000000c1';
const OFFICER = '00000000-0000-4000-8000-0000000000b1';

const encrypt = vi.fn(async () => ({ ciphertext: 'CIPHERTEXT', scheme: 'm.megolm.v1.aes-sha2' }));
vi.mock('../src/e2ee/crypto', async (orig) => ({
  ...(await orig<typeof import('../src/e2ee/crypto')>()),
  getPersonaCrypto: vi.fn(async () => ({
    encrypt,
    decrypt: async () => ({ content: { body: '<img src=x onerror=alert(1)>' }, verified: true }),
    machine: { deviceId: { toString: () => 'PSEUDODEV' } },
  })),
}));

// jsdom has no layout.
Element.prototype.scrollIntoView = () => undefined;

const { TrustPanel } = await import('../src/features/trust/TrustPanel');

const appeal: TrustCase = {
  id: '00000000-0000-4000-8000-0000000000d1',
  alias: 'K7Q2',
  status: 'OPEN',
  service: { id: '00000000-0000-4000-8000-0000000000e1', nameUk: 'Омбудсман ПУЕТ', nameEn: 'PUET Ombudsman' },
  channelId: CHANNEL,
  pseudonymId: PSEUDONYM,
  createdAt: '2026-11-22T09:12:00.000Z',
  closedAt: null,
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url, method, headers, body: init.body ? JSON.parse(init.body as string) : undefined });
      if (url === '/api/trust-services') return json({ enabled: true, services: [{ id: appeal.service.id, code: 'OMBUDSMAN', nameUk: appeal.service.nameUk, nameEn: appeal.service.nameEn }] });
      if (url === '/api/me/appeals') return json([]);
      if (url.endsWith('/appeals') && method === 'POST') return json(appeal, 201);
      if (url.startsWith(`/api/channels/${CHANNEL}/messages`) && method === 'GET')
        return json([
          { id: 'm1', channelId: CHANNEL, senderId: OFFICER, senderDeviceId: 'D', threadRootId: null, scheme: 'm.megolm.v1.aes-sha2', body: null, ciphertext: 'X', isPriority: false, createdAt: '2026-11-22T09:13:00.000Z', editedAt: null, deleted: false },
        ]);
      if (url === `/api/channels/${CHANNEL}/members`) return json([{ userId: PSEUDONYM, role: 'MEMBER' }, { userId: OFFICER, role: 'MODERATOR' }]);
      if (url === `/api/channels/${CHANNEL}/messages` && method === 'POST')
        return json({ id: 'm2', channelId: CHANNEL, senderId: PSEUDONYM, senderDeviceId: 'PSEUDODEV', threadRootId: null, scheme: 'm.megolm.v1.aes-sha2', body: null, ciphertext: 'CIPHERTEXT', isPriority: false, createdAt: '2026-11-22T09:14:00.000Z', editedAt: null, deleted: false }, 201);
      return json({ message: 'Not found' }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TrustPanel />
    </QueryClientProvider>,
  );
}

describe('anonymous appeals', () => {
  it('anonymity: the appeal is opened as the person, then every room request is made as the pseudonym', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Звернутися анонімно' }));
    expect(await screen.findByText('Псевдонім K7Q2')).toBeInTheDocument();

    const open = calls.find((c) => c.method === 'POST' && c.url.endsWith('/appeals'))!;
    expect(open.headers['x-pulse-persona']).toBeUndefined();
    await waitFor(() => expect(calls.some((c) => c.url.startsWith(`/api/channels/${CHANNEL}/messages`))).toBe(true));
    for (const c of calls.filter((x) => x.url.includes(`/channels/${CHANNEL}`))) expect(c.headers['x-pulse-persona']).toBe(PSEUDONYM);
  });

  it('E2EE: a message to the service leaves the device only as ciphertext from the pseudonym device', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Звернутися анонімно' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Повідомлення службі' }), { target: { value: 'Мене ображає викладач' } });
    fireEvent.click(screen.getByRole('button', { name: 'Надіслати' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `/api/channels/${CHANNEL}/messages`)).toBe(true));
    const sent = calls.find((c) => c.method === 'POST' && c.url === `/api/channels/${CHANNEL}/messages`)!;
    expect(sent.headers['x-pulse-persona']).toBe(PSEUDONYM);
    expect(sent.body).toMatchObject({ ciphertext: 'CIPHERTEXT', senderDeviceId: 'PSEUDODEV' });
    expect(JSON.stringify(sent.body)).not.toContain('викладач');
    expect(encrypt).toHaveBeenCalledWith(CHANNEL, [PSEUDONYM, OFFICER], { msgtype: 'm.text', body: 'Мене ображає викладач' });
  });

  it('XSS: decrypted replies from the service render as text', async () => {
    const { container } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Звернутися анонімно' }));
    expect(await screen.findByText(/onerror=alert/)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});
