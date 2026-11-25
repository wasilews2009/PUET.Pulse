import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config';
import { isAllowedPushEndpoint } from '../src/push/push.sender';

const HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', '*.notify.windows.com'];
const baseEnv = {
  NODE_ENV: 'test',
  WEB_ORIGIN: 'https://pulse.test',
  REDIS_URL: 'redis://unused',
  OIDC_ISSUER_URL: 'https://sso.test/realms/puet',
  OIDC_CLIENT_ID: 'pulse',
  OIDC_CLIENT_SECRET: 'secret',
  OIDC_REDIRECT_URI: 'https://pulse.test/api/auth/callback',
};

describe('Web Push', () => {
  it('SSRF: only https endpoints of allowlisted push services', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc', HOSTS)).toBe(true);
    expect(isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x', HOSTS)).toBe(true);
    expect(isAllowedPushEndpoint('https://notify.windows.com/w', HOSTS)).toBe(false);
    expect(isAllowedPushEndpoint('https://evilnotify.windows.com/w', HOSTS)).toBe(false);
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc', HOSTS)).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.test/x', HOSTS)).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com:444/x', HOSTS)).toBe(false);
    expect(isAllowedPushEndpoint('https://user:pw@fcm.googleapis.com/x', HOSTS)).toBe(false);
    expect(isAllowedPushEndpoint('https://169.254.169.254/latest', HOSTS)).toBe(false);
    expect(isAllowedPushEndpoint('not a url', HOSTS)).toBe(false);
  });

  it('push is off without VAPID keys and refuses half a key pair', () => {
    expect(loadConfig(baseEnv).push).toBeNull();
    expect(() => loadConfig({ ...baseEnv, VAPID_PUBLIC_KEY: 'A'.repeat(87) })).toThrow(/VAPID/);
  });

  it('keys from push:keys are accepted and encrypt a payload for a browser key', () => {
    const vapid = webpush.generateVAPIDKeys();
    const cfg = loadConfig({ ...baseEnv, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey });
    expect(cfg.push).toMatchObject({ subject: 'https://pulse.test', subscriptionDays: 14 });
    const browser = createECDH('prime256v1');
    browser.generateKeys();
    const details = webpush.generateRequestDetails(
      { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: browser.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } },
      JSON.stringify({ sender: 'Олена' }),
      { vapidDetails: { subject: cfg.push!.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 60, urgency: 'high', contentEncoding: 'aes128gcm' },
    );
    expect(details.headers['Content-Encoding']).toBe('aes128gcm');
    expect(details.headers.Urgency).toBe('high');
    expect(String(details.headers.Authorization)).toMatch(/^vapid t=.+, k=/);
    // The body is ciphertext: the sender's name is not readable on the wire.
    expect(Buffer.from(details.body as Buffer).toString('utf8')).not.toContain('Олена');
  });
});
