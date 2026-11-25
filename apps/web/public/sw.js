/*
 * PUET.Pulse service worker: caches the application shell only (HTML, hashed
 * JS/CSS, fonts, icons) so the PWA starts offline. API responses, files, the
 * verification pages and anything under /api are never cached: they carry
 * personal data and are served with Cache-Control: no-store.
 */
const SHELL = 'pulse-shell-v1';
const PRECACHE = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/verify/')) return;

  if (req.mode === 'navigate') {
    // Network first so a new deployment is picked up; the cached shell when offline.
    event.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(SHELL).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

// ── Phone notifications (Web Push) ──
// The server's payload names the sender and the chat, never the message text.
// One notification per message: Android launchers count them on the app icon.
const TEXT = {
  uk: { message: 'Нове повідомлення', urgent: 'Термінове' },
  en: { message: 'New message', urgent: 'Urgent' },
};
const PER_CHAT = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const short = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

async function onPush(data) {
  if (!data || data.v !== 1 || data.type !== 'message' || !UUID.test(data.channelId) || !UUID.test(data.messageId)) return;
  if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
    await (data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => undefined);
  }
  // The app is on screen: it shows the message itself.
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (windows.some((c) => c.visibilityState === 'visible')) return;

  const t = TEXT[data.lang === 'en' ? 'en' : 'uk'];
  const sender = short(data.sender, 80) || 'PUET.Pulse';
  const channel = short(data.channel, 80);
  const body = `${data.priority ? `❗ ${t.urgent} · ` : ''}${channel || t.message}`;
  await self.registration.showNotification(sender, {
    body,
    tag: data.messageId,
    data: { channelId: data.channelId },
    icon: '/icon-192.png',
    silent: data.silent === true,
    requireInteraction: data.priority === true,
    timestamp: Date.now(),
  });
  // Keep the shade tidy in a busy chat: only the latest notifications of each chat stay.
  const same = (await self.registration.getNotifications()).filter((n) => n.data && n.data.channelId === data.channelId);
  for (const n of same.slice(0, Math.max(0, same.length - PER_CHAT))) n.close();
}

// A tap opens that chat (in the running app when there is one) and clears its notifications.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const channelId = event.notification.data && event.notification.data.channelId;
  const path = typeof channelId === 'string' && UUID.test(channelId) ? `/chats/${channelId}` : '/chats';
  event.waitUntil(
    (async () => {
      for (const n of await self.registration.getNotifications()) if (n.data && n.data.channelId === channelId) n.close();
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const own = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (!own) return self.clients.openWindow(path);
      await own.focus();
      // The app routes there itself (no reload, so decrypted messages stay in memory).
      own.postMessage({ type: 'pulse.open', path });
      return undefined;
    })(),
  );
});

self.addEventListener('push', (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  event.waitUntil(onPush(data).catch(() => undefined));
});
