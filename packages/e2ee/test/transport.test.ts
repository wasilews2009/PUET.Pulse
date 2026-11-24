import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../src';

describe('HttpTransport', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('calls the global fetch unbound (browsers throw "Illegal invocation" otherwise)', async () => {
    // Mimic the browser: window.fetch refuses any receiver other than window / undefined.
    const browserFetch = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"device_keys":{}}') });
    });
    globalThis.fetch = browserFetch as unknown as typeof fetch;
    const t = new HttpTransport('/api', 'device-1');
    await expect(t.queryKeys('{"device_keys":{}}')).resolves.toBe('{"device_keys":{}}');
    expect(browserFetch).toHaveBeenCalledWith('/api/e2ee/keys/query', expect.objectContaining({ method: 'POST', credentials: 'include' }));
  });
});
