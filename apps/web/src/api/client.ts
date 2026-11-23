/**
 * Thin fetch wrapper for the PUET.Pulse API, mounted at /api on the same origin.
 * The session is an HttpOnly __Host- cookie, so no token is ever visible to
 * JavaScript; the browser adds the Origin header that the API's CSRF check needs.
 */
export const API_BASE = '/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Json = Record<string, unknown> | unknown[];

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: Json | Blob | ArrayBuffer | Uint8Array;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

async function raw(path: string, o: RequestOptions = {}): Promise<Response> {
  const isJson = o.body !== undefined && !(o.body instanceof Blob) && !(o.body instanceof ArrayBuffer) && !(o.body instanceof Uint8Array);
  const res = await fetch(`${API_BASE}${path}`, {
    method: o.method ?? 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      ...(isJson ? { 'content-type': 'application/json' } : o.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}),
      ...o.headers,
    },
    ...(o.body !== undefined ? { body: isJson ? JSON.stringify(o.body) : (o.body as BodyInit) } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (!res.ok) {
    let message = res.statusText || 'Request failed';
    try {
      const data = (await res.json()) as { message?: unknown };
      if (typeof data.message === 'string') message = data.message;
      else if (Array.isArray(data.message)) message = data.message.join('; ');
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  return res;
}

export async function api<T>(path: string, o: RequestOptions = {}): Promise<T> {
  const res = await raw(path, o);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function apiBytes(path: string, o: RequestOptions = {}): Promise<{ bytes: Uint8Array; type: string }> {
  const res = await raw(path, { ...o, headers: { accept: '*/*', ...o.headers } });
  return { bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get('content-type') ?? 'application/octet-stream' };
}

export async function apiText(path: string): Promise<string> {
  return (await raw(path, { headers: { accept: 'text/plain, image/svg+xml' } })).text();
}

/** Only ids that look like UUIDs ever reach a URL (route params come from the address bar). */
export const isUuid = (s: string | undefined): s is string => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
