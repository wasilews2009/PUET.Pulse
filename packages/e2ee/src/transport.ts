/**
 * How the crypto layer talks to the PUET.Pulse API (/e2ee/*). Bodies are the
 * JSON strings produced by matrix-sdk-crypto; responses are returned as JSON
 * strings for `markRequestAsSent`.
 */
export interface E2eeTransport {
  uploadKeys(body: string): Promise<string>;
  queryKeys(body: string): Promise<string>;
  claimKeys(body: string): Promise<string>;
  sendToDevice(eventType: string, txnId: string, body: string): Promise<string>;
  uploadSignatures(body: string): Promise<string>;
  uploadSigningKeys(body: string): Promise<string>;
  putBackupKeys(version: string, body: string): Promise<string>;
  getBackupKeys(version: string): Promise<string>;
  createBackupVersion(body: string): Promise<{ version: string }>;
  currentBackupVersion(): Promise<{ version: string; auth_data: Record<string, unknown> } | null>;
  putSecret(name: string, ciphertext: unknown): Promise<void>;
  getSecret(name: string): Promise<unknown | null>;
  sync(since?: string): Promise<SyncResponse>;
}

export interface SyncResponse {
  next_batch: string;
  to_device: { events: unknown[] };
  device_lists: { changed: string[]; left: string[] };
  device_one_time_keys_count: Record<string, number>;
  device_unused_fallback_key_types: string[];
}

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body?: string; credentials?: 'include' }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/**
 * Fetch-based transport for the browser (cookie session, credentials: include)
 * and for Node clients / tests (pass extra headers such as a cookie).
 */
export class HttpTransport implements E2eeTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly deviceId: string,
    // Browsers throw "Illegal invocation" when fetch is called as a method of another
    // object (this.fetchImpl(...)), so the default calls it unbound.
    private readonly fetchImpl: FetchLike = (input, init) => (globalThis.fetch as unknown as FetchLike)(input, init),
    private readonly headers: () => Record<string, string> = () => ({}),
  ) {}

  private async call(method: string, path: string, body?: string, allow404 = false): Promise<string | null> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...this.headers() },
      ...(body !== undefined ? { body } : {}),
      credentials: 'include',
    });
    if (allow404 && res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`E2EE request ${method} ${path.split('?')[0]} failed with ${res.status}`);
    return text || '{}';
  }

  private dev(path: string) {
    return `/e2ee/devices/${encodeURIComponent(this.deviceId)}${path}`;
  }

  async uploadKeys(body: string) {
    return (await this.call('POST', this.dev('/keys/upload'), body))!;
  }
  async queryKeys(body: string) {
    return (await this.call('POST', '/e2ee/keys/query', body))!;
  }
  async claimKeys(body: string) {
    return (await this.call('POST', '/e2ee/keys/claim', body))!;
  }
  async sendToDevice(eventType: string, txnId: string, body: string) {
    return (await this.call('PUT', this.dev(`/sendToDevice/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`), body))!;
  }
  async uploadSignatures(body: string) {
    return (await this.call('POST', '/e2ee/keys/signatures/upload', body))!;
  }
  async uploadSigningKeys(body: string) {
    return (await this.call('POST', '/e2ee/keys/device_signing/upload', body))!;
  }
  async putBackupKeys(version: string, body: string) {
    return (await this.call('PUT', `/e2ee/room_keys/keys?version=${encodeURIComponent(version)}`, body))!;
  }
  async getBackupKeys(version: string) {
    return (await this.call('GET', `/e2ee/room_keys/keys?version=${encodeURIComponent(version)}`))!;
  }
  async createBackupVersion(body: string) {
    return JSON.parse((await this.call('POST', '/e2ee/room_keys/version', body))!) as { version: string };
  }
  async currentBackupVersion() {
    const text = await this.call('GET', '/e2ee/room_keys/version', undefined, true);
    return text ? (JSON.parse(text) as { version: string; auth_data: Record<string, unknown> }) : null;
  }
  async putSecret(name: string, ciphertext: unknown) {
    await this.call('PUT', `/e2ee/secrets/${encodeURIComponent(name)}`, JSON.stringify({ ciphertext }));
  }
  async getSecret(name: string) {
    const text = await this.call('GET', `/e2ee/secrets/${encodeURIComponent(name)}`, undefined, true);
    return text ? (JSON.parse(text) as { ciphertext: unknown }).ciphertext : null;
  }
  async sync(since?: string) {
    const q = since ? `?since=${encodeURIComponent(since)}` : '';
    return JSON.parse((await this.call('GET', this.dev(`/sync${q}`)))!) as SyncResponse;
  }
}
