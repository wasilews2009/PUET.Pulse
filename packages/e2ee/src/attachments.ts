/**
 * Attachments of end-to-end encrypted rooms (Phase 9). Each file gets a fresh
 * random AES-256-GCM key and 96-bit IV from WebCrypto; the server stores only
 * the ciphertext, and the key travels inside the Megolm-encrypted message, so
 * only the room's devices can read the file. GCM authenticates the bytes; the
 * SHA-256 of the ciphertext lets the receiver refuse a swapped blob before
 * decrypting. No custom cryptography: WebCrypto primitives only.
 */

export const ATTACHMENT_SCHEME = 'puet.aes-256-gcm.v1';

export interface EncryptedFileInfo {
  v: typeof ATTACHMENT_SCHEME;
  /** Raw 256-bit key, base64. */
  key: string;
  /** 96-bit IV, base64. */
  iv: string;
  /** SHA-256 of the ciphertext, hex. */
  sha256: string;
}

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto is not available');
  return s;
};

const toB64 = (b: Uint8Array) => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Encrypts a file for a room. The caller uploads `ciphertext` and puts `info` into the encrypted message. */
export async function encryptAttachment(plain: Uint8Array): Promise<{ ciphertext: Uint8Array; info: EncryptedFileInfo }> {
  const key = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, plain as BufferSource));
  const raw = new Uint8Array(await subtle().exportKey('raw', key));
  const sha256 = toHex(await subtle().digest('SHA-256', ciphertext as BufferSource));
  return { ciphertext, info: { v: ATTACHMENT_SCHEME, key: toB64(raw), iv: toB64(iv), sha256 } };
}

export class AttachmentError extends Error {}

/** Checks the hash, then decrypts. Throws AttachmentError for anything that does not match. */
export async function decryptAttachment(ciphertext: Uint8Array, info: EncryptedFileInfo): Promise<Uint8Array> {
  if (info?.v !== ATTACHMENT_SCHEME || typeof info.key !== 'string' || typeof info.iv !== 'string' || !/^[0-9a-f]{64}$/.test(info.sha256)) {
    throw new AttachmentError('Unknown attachment format');
  }
  const digest = toHex(await subtle().digest('SHA-256', ciphertext as BufferSource));
  if (digest !== info.sha256) throw new AttachmentError('The attachment does not match its message');
  const raw = fromB64(info.key);
  const iv = fromB64(info.iv);
  if (raw.length !== 32 || iv.length !== 12) throw new AttachmentError('Unknown attachment format');
  const key = await subtle().importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['decrypt']);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ciphertext as BufferSource));
  } catch {
    throw new AttachmentError('The attachment could not be decrypted');
  }
}
