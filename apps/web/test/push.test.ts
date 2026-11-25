import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncBadge } from '../src/features/shell/push';

const CH = '11111111-1111-4111-8111-111111111111';
const MSG = '22222222-2222-4222-8222-222222222222';

/** Loads public/sw.js against a fake ServiceWorkerGlobalScope. */
function loadWorker(opts: { visible?: boolean } = {}) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const shown: { title: string; options: NotificationOptions & { data?: { channelId: string } }; close: () => void }[] = [];
  const self = {
    location: { origin: 'https://pulse.test' },
    navigator: { setAppBadge: vi.fn().mockResolvedValue(undefined), clearAppBadge: vi.fn().mockResolvedValue(undefined) },
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
    skipWaiting: vi.fn(),
    clients: {
      matchAll: vi.fn().mockResolvedValue(opts.visible ? [{ url: 'https://pulse.test/chats', visibilityState: 'visible', focus: vi.fn(), postMessage: vi.fn() }] : []),
      openWindow: vi.fn(),
      claim: vi.fn(),
    },
    registration: {
      showNotification: vi.fn(async (title: string, options: NotificationOptions & { data?: { channelId: string } }) => {
        const n = { title, options, data: options.data, close: () => shown.splice(shown.indexOf(n), 1) };
        shown.push(n);
      }),
      getNotifications: vi.fn(async () => [...shown]),
    },
  };
  new Function('self', 'caches', readFileSync(resolve(__dirname, '../public/sw.js'), 'utf8'))(self, {});
  const push = async (data: unknown) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.push!({ data: { json: () => data }, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  return { self, shown, push, listeners };
}

const payload = (over: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'message',
  channelId: CH,
  messageId: MSG,
  sender: 'Олена Коваль',
  channel: null,
  priority: false,
  silent: false,
  badge: 3,
  lang: 'uk',
  ...over,
});

describe('phone notifications (service worker)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names the sender, opens the chat on tap and sets the icon badge', async () => {
    const w = loadWorker();
    await w.push(payload());
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]!.title).toBe('Олена Коваль');
    expect(w.shown[0]!.options).toMatchObject({ body: 'Нове повідомлення', tag: MSG, data: { channelId: CH } });
    expect(w.self.navigator.setAppBadge).toHaveBeenCalledWith(3);
  });

  it('group chats show the chat name; urgent messages are marked', async () => {
    const w = loadWorker();
    await w.push(payload({ channel: 'КН-21', priority: true, lang: 'en' }));
    expect(w.shown[0]!.options.body).toBe('❗ Urgent · КН-21');
    expect(w.shown[0]!.options.requireInteraction).toBe(true);
  });

  it('one notification per message, at most 20 per chat', async () => {
    const w = loadWorker();
    for (let i = 0; i < 25; i++) await w.push(payload({ messageId: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}` }));
    expect(w.shown).toHaveLength(20);
  });

  it('nothing pops up while the app is on screen (the badge still updates)', async () => {
    const w = loadWorker({ visible: true });
    await w.push(payload());
    expect(w.shown).toHaveLength(0);
    expect(w.self.navigator.setAppBadge).toHaveBeenCalledWith(3);
  });

  it('ignores malformed pushes', async () => {
    const w = loadWorker();
    await w.push({ v: 1, type: 'message', channelId: '../../admin', messageId: MSG });
    await w.push(null);
    expect(w.shown).toHaveLength(0);
  });

  it('a tap opens that chat in the running app', async () => {
    const w = loadWorker();
    await w.push(payload());
    const client = { url: 'https://pulse.test/settings', visibilityState: 'hidden', focus: vi.fn(), postMessage: vi.fn() };
    w.self.clients.matchAll.mockResolvedValue([client]);
    let done: Promise<unknown> = Promise.resolve();
    w.listeners.notificationclick!({ notification: w.shown[0], waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect(client.postMessage).toHaveBeenCalledWith({ type: 'pulse.open', path: `/chats/${CH}` });
    expect(w.shown).toHaveLength(0);
  });
});

describe('app icon badge', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sets the unread count and closes notifications of chats that were read', async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadge });
    const read = { data: { channelId: CH }, close: vi.fn() };
    const unread = { data: { channelId: 'other' }, close: vi.fn() };
    const reg = { getNotifications: vi.fn().mockResolvedValue([read, unread]) };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: () => Promise.resolve(reg), ready: Promise.resolve(reg) } });
    await syncBadge(5, new Set([CH]));
    expect(setAppBadge).toHaveBeenCalledWith(5);
    expect(read.close).toHaveBeenCalled();
    expect(unread.close).not.toHaveBeenCalled();
  });
});
