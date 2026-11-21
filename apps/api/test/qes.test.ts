import { describe, expect, it } from 'vitest';
import { ExternalQesAdapter, QesUnavailableError, SignatureRejectedError, sameFullName } from '../src/pki/signature-provider';
import { createRootCa, fromPem } from '../src/pki/x509';

const NOW = new Date('2026-11-23T10:00:00Z');

async function gateway(over: Record<string, unknown> = {}) {
  const { certificatePem } = await createRootCa({ commonName: 'Іваненко Марʼяна', years: 2 });
  const answer = {
    valid: true,
    format: 'CAdES-X-Long',
    qualified: true,
    signer: { certificate: fromPem(certificatePem, 'CERTIFICATE').toString('base64'), fullName: 'Іваненко Марʼяна' },
    ocsp: { status: 'good', checkedAt: new Date(NOW.getTime() - 60_000).toISOString() },
    tsp: { valid: true, time: new Date(NOW.getTime() - 30_000).toISOString() },
    ...over,
  };
  const calls: { url: string; auth: string | null; body: string }[] = [];
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), body: String(init.body) });
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { adapter: new ExternalQesAdapter({ url: 'https://qes-gw.puet.local', token: 'gw-token-0123456789' }, fetchImpl), calls };
}

describe('External QES adapter (КЕП through the certified gateway)', () => {
  it('accepts a qualified signature with a fresh good OCSP answer and a valid TSP', async () => {
    const { adapter, calls } = await gateway();
    const v = await adapter.verify(Buffer.from('sig'), Buffer.from('doc'), NOW);
    expect(v).toMatchObject({ provider: 'EXTERNAL_QES', format: 'CAdES-X-Long', revocation: { source: 'ocsp' } });
    expect(v.tsp?.time.toISOString()).toBe('2026-11-23T09:59:30.000Z');
    expect(calls[0]).toMatchObject({ url: 'https://qes-gw.puet.local/v1/verify-detached', auth: 'Bearer gw-token-0123456789' });
  });

  it.each([
    ['revoked certificate (OCSP)', { ocsp: { status: 'revoked', checkedAt: NOW.toISOString() } }],
    ['stale OCSP answer', { ocsp: { status: 'good', checkedAt: '2026-11-22T10:00:00Z' } }],
    ['missing TSP timestamp', { tsp: null }],
    ['invalid TSP timestamp', { tsp: { valid: false, time: NOW.toISOString() } }],
    ['TSP time in the future', { tsp: { valid: true, time: '2026-11-24T00:00:00Z' } }],
    ['non-qualified certificate', { qualified: false }],
    ['invalid signature', { valid: false }],
  ])('rejects: %s', async (_name, over) => {
    const { adapter } = await gateway(over);
    await expect(adapter.verify(Buffer.from('sig'), Buffer.from('doc'), NOW)).rejects.toBeInstanceOf(SignatureRejectedError);
  });

  it('a broken or unconfigured gateway is "unavailable", never "valid"', async () => {
    const down = new ExternalQesAdapter({ url: 'https://qes-gw.puet.local', token: 'gw-token-0123456789' }, (async () => new Response('oops', { status: 502 })) as unknown as typeof fetch);
    await expect(down.verify(Buffer.from('s'), Buffer.from('d'), NOW)).rejects.toBeInstanceOf(QesUnavailableError);
    const garbage = new ExternalQesAdapter({ url: 'https://qes-gw.puet.local', token: 'gw-token-0123456789' }, (async () => new Response('{"valid":true}')) as unknown as typeof fetch);
    await expect(garbage.verify(Buffer.from('s'), Buffer.from('d'), NOW)).rejects.toBeInstanceOf(QesUnavailableError);
    await expect(new ExternalQesAdapter(null).verify(Buffer.from('s'), Buffer.from('d'), NOW)).rejects.toBeInstanceOf(QesUnavailableError);
  });

  it('binds certificates by holder name regardless of case and apostrophe form', () => {
    expect(sameFullName("Іваненко Мар'яна", 'іваненко  марʼяна')).toBe(true);
    expect(sameFullName('Іваненко Марʼяна', 'Іваненко Марія')).toBe(false);
  });
});
