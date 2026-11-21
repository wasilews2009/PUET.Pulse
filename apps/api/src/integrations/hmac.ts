import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature: `X-PUET-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * HMAC-SHA256 from Node's OpenSSL binding; constant-time comparison; timestamp window
 * against replay (the idempotency ledger covers replays inside the window).
 */
export const SIGNATURE_HEADER = 'x-puet-signature';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

export function sign(secret: string, timestamp: number, body: Buffer | string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

export function verifySignature(p: {
  secret: string;
  header: string | undefined;
  body: Buffer | undefined;
  nowSeconds: number;
  toleranceSeconds: number;
}): SignatureCheck {
  if (!p.header || !p.body) return { ok: false, reason: 'signature.missing' };
  const parts = new Map<string, string>();
  for (const part of p.header.split(',')) {
    const i = part.indexOf('=');
    if (i > 0) parts.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: 'signature.malformed' };
  if (Math.abs(p.nowSeconds - t) > p.toleranceSeconds) return { ok: false, reason: 'signature.stale' };

  const expected = createHmac('sha256', p.secret).update(`${t}.`).update(p.body).digest();
  const given = Buffer.from(v1, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'signature.invalid' };
  }
  return { ok: true };
}
