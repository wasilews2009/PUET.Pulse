/**
 * Wraps a secret (the key-backup decryption key) under the user's master
 * passphrase, entirely on the client, with standard WebCrypto primitives:
 * PBKDF2-HMAC-SHA-256 (600 000 iterations, OWASP 2023) derives an AES-256-GCM key.
 * No custom cryptography: only the platform's audited implementations are used.
 * The server stores the resulting JSON and can neither read nor brute-force it cheaply.
 */

export const WRAP_ALGORITHM = 'puet.pbkdf2-sha256.aes-256-gcm.v1';
export const DEFAULT_ITERATIONS = 600_000;
const MIN_PASSPHRASE = 12;

export interface WrappedSecret {
  algorithm: typeof WRAP_ALGORITHM;
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

const subtle = () => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('WebCrypto is not available');
  return c.subtle;
};

const toB64 = (b: ArrayBuffer | Uint8Array) => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
};
const fromB64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', new TextEncoder().encode(passphrase.normalize('NFKC')), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function wrapSecret(secret: string, passphrase: string, iterations = DEFAULT_ITERATIONS): Promise<WrappedSecret> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`The master passphrase needs at least ${MIN_PASSPHRASE} characters`);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const aad = new TextEncoder().encode(WRAP_ALGORITHM);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, new TextEncoder().encode(secret));
  return { algorithm: WRAP_ALGORITHM, iterations, salt: toB64(salt), iv: toB64(iv), ciphertext: toB64(ct) };
}

/** Throws on a wrong passphrase or any tampering (GCM authentication). */
export async function unwrapSecret(wrapped: WrappedSecret, passphrase: string): Promise<string> {
  if (wrapped.algorithm !== WRAP_ALGORITHM) throw new Error('Unsupported wrapping algorithm');
  if (!Number.isInteger(wrapped.iterations) || wrapped.iterations < 100_000) throw new Error('Too few PBKDF2 iterations');
  const key = await deriveKey(passphrase, fromB64(wrapped.salt), wrapped.iterations);
  const aad = new TextEncoder().encode(WRAP_ALGORITHM);
  try {
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromB64(wrapped.iv), additionalData: aad },
      key,
      fromB64(wrapped.ciphertext),
    );
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error('Wrong passphrase or damaged backup');
  }
}
