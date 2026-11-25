/**
 * Phone notifications (Web Push) against a real PostgreSQL: subscriptions are
 * bound to the signed-in person and session, pushes name the sender but never
 * the text, the badge counts unread messages, and logout / offboarding stop them.
 *
 *   RUN_DB_TESTS=1 DATABASE_URL=... pnpm --filter @puet/api test
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@puet/database';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule, REDIS } from '../../src/app.module';
import { OIDC_PROVIDER, type IdTokenClaims, type OidcProvider } from '../../src/auth/oidc.service';
import { APP_CONFIG, loadConfig } from '../../src/config/config';
import { SyncService } from '../../src/integrations/sync.service';
import { DIGEST_STORE, MemoryDigestStore } from '../../src/notifications/digest.store';
import { NotificationService } from '../../src/notifications/notification.service';
import { PUSH_SENDER, type PushOptions, type PushSender, type PushTarget } from '../../src/push/push.sender';
import { PushService } from '../../src/push/push.service';
import { MemoryRealtimeBus, REALTIME_BUS } from '../../src/realtime/realtime.bus';
import { MemorySessionStore, SESSION_STORE } from '../../src/session/session.store';

const enabled = process.env.RUN_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const WEB = 'https://pulse.test';
const sfx = randomUUID().slice(0, 8).toUpperCase();
const b64 = (n: number) => randomBytes(n).toString('base64url');

class FakePushSender implements PushSender {
  readonly enabled = true;
  sent: { target: PushTarget; payload: Record<string, unknown>; options: PushOptions }[] = [];
  gone = new Set<string>();
  async send(target: PushTarget, payload: string, options: PushOptions) {
    if (this.gone.has(target.endpoint)) return 'gone' as const;
    this.sent.push({ target, payload: JSON.parse(payload) as Record<string, unknown>, options });
    return 'ok' as const;
  }
}

let nextClaims: IdTokenClaims = { sub: 'nobody' };
const fakeOidc: OidcProvider = {
  authorizationUrl: async (p) => `https://sso.test/auth?state=${p.state}`,
  exchange: async () => nextClaims,
  endSessionUrl: async () => undefined,
};

describe.skipIf(!enabled)('Web Push notifications (PostgreSQL)', () => {
  let app: INestApplication;
  let base: string;
  const prisma = new PrismaClient();
  const sender = new FakePushSender();
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let dm: string;

  async function http(path: string, init: RequestInit & { cookie?: string } = {}) {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set('cookie', init.cookie);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (init.method && init.method !== 'GET') headers.set('origin', WEB);
    return fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' });
  }
  const as = (who: string) => ({
    get: (path: string) => http(path, { cookie: cookies[who]! }),
    post: (path: string, body: unknown = {}) => http(path, { method: 'POST', cookie: cookies[who]!, body: JSON.stringify(body) }),
    del: (path: string, body: unknown) => http(path, { method: 'DELETE', cookie: cookies[who]!, body: JSON.stringify(body) }),
  });

  async function login(who: string) {
    nextClaims = { sub: `sub-${who}-${sfx}`, email: `${who.toLowerCase()}-${sfx}@puet.test`, amr: ['pwd'] };
    let res = await http('/auth/login?returnTo=/chats');
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    res = await http(`/auth/callback?code=c&state=${state}`);
    const sc = res.headers.get('set-cookie');
    if (!sc) throw new Error(`login failed for ${who}`);
    cookies[who] = sc.split(';')[0]!;
  }

  const subscription = (host = 'fcm.googleapis.com') => ({
    endpoint: `https://${host}/fcm/send/${b64(24)}`,
    keys: { p256dh: b64(65), auth: b64(16) },
    expirationTime: null,
  });

  async function send(from: string, body: string) {
    const res = await as(from).post(`/channels/${dm}/messages`, { body });
    expect(res.status).toBe(201);
    await app.get(NotificationService).lastPush;
    return (await res.json()) as { id: string };
  }

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      WEB_ORIGIN: WEB,
      REDIS_URL: 'redis://unused',
      OIDC_ISSUER_URL: 'https://sso.test/realms/puet',
      OIDC_CLIENT_ID: 'pulse',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_REDIRECT_URI: `${WEB}/api/auth/callback`,
      JOBS_ENABLED: 'false',
      VAPID_PUBLIC_KEY: b64(65),
      VAPID_PRIVATE_KEY: b64(32),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(REDIS)
      .useValue({})
      .overrideProvider(SESSION_STORE)
      .useValue(new MemorySessionStore())
      .overrideProvider(OIDC_PROVIDER)
      .useValue(fakeOidc)
      .overrideProvider(REALTIME_BUS)
      .useValue(new MemoryRealtimeBus())
      .overrideProvider(DIGEST_STORE)
      .useValue(new MemoryDigestStore())
      .overrideProvider(PUSH_SENDER)
      .useValue(sender)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: ['error'] });
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const tenantId = (await prisma.tenant.findUniqueOrThrow({ where: { code: 'PUET_MAIN' } })).id;
    const names: Record<string, [string, string]> = { A: ['Олена Коваль', 'Olena Koval'], B: ['Петро Шевчук', 'Petro Shevchuk'] };
    for (const who of ['A', 'B']) {
      const u = await prisma.user.create({
        data: {
          tenantId,
          corporateId: `${who}-${sfx}`,
          email: `${who.toLowerCase()}-${sfx}@puet.test`,
          fullNameUk: names[who]![0],
          fullNameEn: names[who]![1],
          oidcSubject: `sub-${who}-${sfx}`,
          kind: 'STAFF',
          locale: who === 'B' ? 'en' : 'uk',
          roleAssignments: { create: { role: 'LECTURER', tenantId, source: 'ADMIN' } },
        },
      });
      ids[who] = u.id;
      await login(who);
    }
    const res = await as('A').post(`/users/${ids.B}/direct`);
    expect(res.status).toBeLessThan(300);
    dm = ((await res.json()) as { channelId: string }).channelId;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  beforeEach(() => {
    sender.sent = [];
  });

  it('gives the public VAPID key to a signed-in person only', async () => {
    expect((await http('/push/config')).status).toBe(401);
    const cfg = (await (await as('A').get('/push/config')).json()) as { enabled: boolean; publicKey: string };
    expect(cfg.enabled).toBe(true);
    expect(cfg.publicKey).toMatch(/^[A-Za-z0-9_-]{80,100}$/);
  });

  it('SSRF: refuses endpoints outside the push services allowlist', async () => {
    for (const host of ['evil.test', '127.0.0.1', 'fcm.googleapis.com.evil.test', 'fcm.googleapis.com:8443']) {
      expect((await as('A').post('/push/subscriptions', subscription(host))).status).toBe(403);
    }
    const http1 = { ...subscription(), endpoint: 'http://fcm.googleapis.com/fcm/send/x' };
    expect((await as('A').post('/push/subscriptions', http1)).status).toBe(400);
  });

  it('a new message pushes the sender name, the unread badge and no text', async () => {
    const sub = subscription();
    expect((await as('B').post('/push/subscriptions', sub)).status).toBe(200);
    const m1 = await send('A', 'секретний текст 1');
    await send('A', 'секретний текст 2');
    expect(sender.sent).toHaveLength(2);
    const [first, second] = sender.sent;
    expect(first!.target.endpoint).toBe(sub.endpoint);
    expect(first!.payload).toMatchObject({ type: 'message', channelId: dm, messageId: m1.id, sender: 'Olena Koval', channel: null, lang: 'en', silent: false, badge: 1 });
    expect(second!.payload.badge).toBe(2);
    expect(first!.options.urgency).toBe('high');
    // Privacy: the payload never carries the message body.
    expect(JSON.stringify(sender.sent)).not.toContain('секретний');
    // The sender's own phone is never notified.
    expect(sender.sent.every((s) => s.target.endpoint === sub.endpoint)).toBe(true);
  });

  it('reading the chat resets the badge; muting stops the push', async () => {
    expect((await as('B').post(`/channels/${dm}/read`, {})).status).toBe(200);
    await send('A', 'ще');
    expect(sender.sent.at(-1)!.payload.badge).toBe(1);
    sender.sent = [];
    await prisma.channelMember.update({ where: { channelId_userId: { channelId: dm, userId: ids.B! } }, data: { mutedUntil: new Date(Date.now() + 3_600_000) } });
    await send('A', 'тихо');
    expect(sender.sent).toHaveLength(0);
    await prisma.channelMember.update({ where: { channelId_userId: { channelId: dm, userId: ids.B! } }, data: { mutedUntil: null } });
  });

  it('IDOR: one person cannot remove another person\'s subscription', async () => {
    const sub = (await prisma.pushSubscription.findFirstOrThrow({ where: { userId: ids.B } })).endpoint;
    expect((await as('A').del('/push/subscriptions', { endpoint: sub })).status).toBe(204);
    expect(await prisma.pushSubscription.count({ where: { endpoint: sub } })).toBe(1);
  });

  it('a subscription the browser dropped (410) is deleted', async () => {
    const sub = subscription();
    await as('B').post('/push/subscriptions', sub);
    sender.gone.add(sub.endpoint);
    await send('A', 'x');
    expect(await prisma.pushSubscription.count({ where: { endpoint: sub.endpoint } })).toBe(0);
  });

  it('logout stops the pushes of that phone at once', async () => {
    expect(await prisma.pushSubscription.count({ where: { userId: ids.B } })).toBeGreaterThan(0);
    expect((await as('B').post('/auth/logout')).status).toBe(200);
    expect(await prisma.pushSubscription.count({ where: { userId: ids.B } })).toBe(0);
    await send('A', 'x');
    expect(sender.sent).toHaveLength(0);
    await login('B');
  });

  it('expired subscriptions are not used and are purged', async () => {
    const sub = subscription();
    await as('B').post('/push/subscriptions', sub);
    await prisma.pushSubscription.update({ where: { endpoint: sub.endpoint }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await send('A', 'x');
    expect(sender.sent).toHaveLength(0);
    expect(await app.get(PushService).purgeExpired()).toBeGreaterThanOrEqual(1);
  });

  it('offboarding removes every subscription of the person', async () => {
    await as('B').post('/push/subscriptions', subscription());
    await app.get(SyncService).offboardUser(ids.B!, 'DISMISSED', null);
    expect(await prisma.pushSubscription.count({ where: { userId: ids.B } })).toBe(0);
    await send('A', 'x');
    expect(sender.sent).toHaveLength(0);
  });
});
