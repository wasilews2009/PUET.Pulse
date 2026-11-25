import webpush from 'web-push';

export const PUSH_SENDER = Symbol('PUSH_SENDER');

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushOptions {
  /** Seconds the push service keeps the message for an offline phone. */
  ttlSeconds: number;
  urgency: 'normal' | 'high';
}

/** `gone`: the browser dropped the subscription (404 / 410); the caller deletes it. */
export type PushResult = 'ok' | 'gone' | 'error';

export interface PushSender {
  readonly enabled: boolean;
  send(target: PushTarget, payload: string, options: PushOptions): Promise<PushResult>;
}

/**
 * Web Push through the audited `web-push` library: it signs the VAPID JWT and
 * encrypts the payload for the device (RFC 8291, aes128gcm), so the push
 * service (FCM, Mozilla, Apple) relays bytes it cannot read.
 */
export class WebPushSender implements PushSender {
  readonly enabled = true;

  constructor(private readonly vapid: { subject: string; publicKey: string; privateKey: string }) {}

  async send(target: PushTarget, payload: string, options: PushOptions): Promise<PushResult> {
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        payload,
        {
          vapidDetails: this.vapid,
          TTL: options.ttlSeconds,
          urgency: options.urgency,
          timeout: 10_000,
          contentEncoding: 'aes128gcm',
        },
      );
      return 'ok';
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      return status === 404 || status === 410 ? 'gone' : 'error';
    }
  }
}

/** VAPID keys not configured: phones get no push, the app still notifies while it is open. */
export class DisabledPushSender implements PushSender {
  readonly enabled = false;
  async send(): Promise<PushResult> {
    return 'error';
  }
}

/** True when the endpoint is https on an allowlisted push host (exact or `*.suffix`). */
export function isAllowedPushEndpoint(endpoint: string, hosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return hosts.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h));
}
