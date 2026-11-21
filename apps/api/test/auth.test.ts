import { RoleCode } from '@puet/shared';
import { describe, expect, it } from 'vitest';
import { idTokenProvesMfa, requiresMfa, safeReturnTo } from '../src/auth/mfa';
import { sign, verifySignature } from '../src/integrations/hmac';
import { computeIsMinor } from '../src/integrations/schemas';
import { MemorySessionStore } from '../src/session/session.store';
import { loadConfig } from '../src/config/config';

const mfaCfg = { mfaAcrValues: ['mfa', '2'], mfaAmrValues: ['otp', 'hwk'] };

describe('MFA from ID token claims', () => {
  it('accepts acr or amr evidence', () => {
    expect(idTokenProvesMfa({ acr: 'mfa' }, mfaCfg)).toBe(true);
    expect(idTokenProvesMfa({ amr: ['pwd', 'otp'] }, mfaCfg)).toBe(true);
  });

  it('rejects password-only logins and malformed claims', () => {
    expect(idTokenProvesMfa({ acr: '1', amr: ['pwd'] }, mfaCfg)).toBe(false);
    expect(idTokenProvesMfa({ amr: 'otp' }, mfaCfg)).toBe(false);
    expect(idTokenProvesMfa({}, mfaCfg)).toBe(false);
  });

  it('knows which roles need MFA, ignoring expired grants', () => {
    expect(requiresMfa([{ role: RoleCode.LECTURER, tenantId: 't' }])).toBe(false);
    expect(requiresMfa([{ role: RoleCode.ADMIN_STAFF, tenantId: 't' }])).toBe(true);
    expect(requiresMfa([{ role: RoleCode.SUPER_ADMIN, tenantId: '*', expiresAt: new Date(0) }])).toBe(false);
  });
});

describe('open redirect prevention', () => {
  it('keeps same-site relative paths', () => {
    expect(safeReturnTo('/chats/123?x=1')).toBe('/chats/123?x=1');
  });

  it('rejects absolute, protocol-relative and backslash URLs', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/a\nb', 42]) {
      expect(safeReturnTo(bad)).toBe('/');
    }
  });
});

describe('webhook HMAC signatures', () => {
  const secret = 'x'.repeat(40);
  const body = Buffer.from('{"records":[]}');
  const now = 1_800_000_000;

  it('accepts a fresh, correct signature', () => {
    const header = sign(secret, now, body);
    expect(verifySignature({ secret, header, body, nowSeconds: now + 10, toleranceSeconds: 300 })).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const header = sign(secret, now, body);
    const tampered = Buffer.from('{"records":[{"edeboId":"x"}]}');
    expect(verifySignature({ secret, header, body: tampered, nowSeconds: now, toleranceSeconds: 300 })).toMatchObject({
      reason: 'signature.invalid',
    });
  });

  it('rejects a wrong secret, a stale timestamp and malformed headers', () => {
    const header = sign(secret, now, body);
    expect(verifySignature({ secret: 'y'.repeat(40), header, body, nowSeconds: now, toleranceSeconds: 300 }).ok).toBe(false);
    expect(verifySignature({ secret, header, body, nowSeconds: now + 301, toleranceSeconds: 300 })).toMatchObject({
      reason: 'signature.stale',
    });
    expect(verifySignature({ secret, header: 'v1=abc', body, nowSeconds: now, toleranceSeconds: 300 }).ok).toBe(false);
    expect(verifySignature({ secret, header: undefined, body, nowSeconds: now, toleranceSeconds: 300 }).ok).toBe(false);
  });
});

describe('minor status from ЄДЕБО birth dates', () => {
  const now = new Date('2026-11-21T00:00:00Z');
  it('is a minor until the 18th birthday', () => {
    expect(computeIsMinor('2008-11-22', false, now)).toBe(true);
    expect(computeIsMinor('2008-11-21', false, now)).toBe(false);
  });
  it('treats everyone in a minor-protected tenant (lyceum) as a minor', () => {
    expect(computeIsMinor('1990-01-01', true, now)).toBe(true);
  });
  it('without a birth date, an adult tenant defaults to adult', () => {
    expect(computeIsMinor(undefined, false, now)).toBe(false);
  });
});

describe('session store', () => {
  it('stores only token digests and destroys all sessions of a user', async () => {
    const store = new MemorySessionStore();
    const data = { userId: 'u1', epoch: 0, mfaVerified: false, createdAt: 0, lastSeenAt: 0 };
    const a = await store.create(data, 60_000);
    const b = await store.create(data, 60_000);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await store.destroyAllForUser('u1')).toBe(2);
    expect(await store.get(a)).toBeNull();
  });

  it('OIDC transactions are one-time use', async () => {
    const store = new MemorySessionStore();
    await store.putTransaction('state', { codeVerifier: 'v', nonce: 'n', returnTo: '/', stepUp: false }, 60_000);
    expect(await store.takeTransaction('state')).not.toBeNull();
    expect(await store.takeTransaction('state')).toBeNull();
  });
});

describe('configuration', () => {
  const base = {
    WEB_ORIGIN: 'https://pulse.puet.edu.ua/app',
    REDIS_URL: 'redis://localhost',
    OIDC_ISSUER_URL: 'https://sso.puet.edu.ua/realms/puet',
    OIDC_CLIENT_ID: 'pulse',
    OIDC_CLIENT_SECRET: 's',
    OIDC_REDIRECT_URI: 'https://pulse.puet.edu.ua/api/auth/callback',
  };

  it('normalizes the web origin and parses integration clients', () => {
    const cfg = loadConfig({
      ...base,
      INTEGRATION_CLIENTS: JSON.stringify({
        edebo: { id: '7d0d1c1e-6b1f-4c39-9a51-1c3a4b5c6d7e', secret: 's'.repeat(32), tenantCode: 'PUET_MAIN', kinds: ['EDEBO_STUDENTS'] },
      }),
    });
    expect(cfg.webOrigin).toBe('https://pulse.puet.edu.ua');
    expect(cfg.integrations.clients.get('edebo')?.tenantCode).toBe('PUET_MAIN');
  });

  it('refuses short integration secrets and names only the bad fields', () => {
    expect(() =>
      loadConfig({
        ...base,
        INTEGRATION_CLIENTS: JSON.stringify({ x: { id: '7d0d1c1e-6b1f-4c39-9a51-1c3a4b5c6d7e', secret: 'short', tenantCode: 'PUET_MAIN', kinds: ['HR_STAFF'] } }),
      }),
    ).toThrow(/INTEGRATION_CLIENTS/);
    expect(() => loadConfig({ ...base, OIDC_CLIENT_SECRET: '' })).toThrow(/OIDC_CLIENT_SECRET/);
  });
});
