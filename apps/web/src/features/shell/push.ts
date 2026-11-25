import { api } from '../../api/client';

/**
 * Phone notifications (Web Push). The service worker shows them even when the
 * app is in the background or closed; the server sends the sender's and the
 * chat's name, never the message text. On Android the launcher counts these
 * notifications on the app icon; where the Badging API exists (iOS home-screen
 * app, Windows / macOS) the icon shows the unread count itself.
 */

export type PushState = 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on';

let active = false;
/** True once this browser is subscribed: in-app notifications then leave the job to the service worker. */
export const isPushActive = () => active;

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => {
  if (!a || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
};

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  return reg ? navigator.serviceWorker.ready : undefined;
}

/**
 * Subscribes this browser (or refreshes the subscription) for the signed-in
 * person. With `ask`, asks for the notification permission first: browsers
 * allow that only from a tap.
 */
export async function enablePush(ask: boolean): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'default' && ask) await Notification.requestPermission();
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const cfg = await api<{ enabled: boolean; publicKey: string | null }>('/push/config');
  if (!cfg.enabled || !cfg.publicKey) return 'unavailable';
  const reg = await registration();
  if (!reg) return 'unavailable';
  const key = keyBytes(cfg.publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    // The server's keys changed: the old subscription can no longer be used.
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  await api('/push/subscriptions', { method: 'POST', body: { endpoint: json.endpoint ?? '', keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } } });
  active = true;
  return 'on';
}

/** Current state without asking anything (for the settings card). */
export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && active ? 'on' : 'off';
}

/** This person no longer wants notifications on this phone. */
export async function disablePush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api('/push/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  active = false;
}

/**
 * Keeps the app icon in step with the unread count and removes the phone
 * notifications of chats that have been read (here or on another device).
 */
export async function syncBadge(unread: number, readChannelIds: ReadonlySet<string>): Promise<void> {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    if (unread > 0) await nav.setAppBadge?.(unread);
    else await nav.clearAppBadge?.();
  } catch {
    /* not supported here */
  }
  const reg = await registration();
  if (!reg) return;
  const shown = await reg.getNotifications().catch(() => [] as Notification[]);
  for (const n of shown) {
    const channelId = (n.data as { channelId?: unknown } | null)?.channelId;
    if (typeof channelId === 'string' && readChannelIds.has(channelId)) n.close();
  }
}
