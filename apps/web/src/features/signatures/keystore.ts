/**
 * The user's signing key for the internal university CA. It is a WebCrypto
 * ECDSA P-256 key generated with extractable = false and kept in IndexedDB as a
 * CryptoKey object: the browser can sign with it, but no script (ours included)
 * can read the private key, and it never leaves the device (CLAUDE.md §1.3).
 */
const DB = 'pulse-signing';
const STORE = 'keys';

interface StoredKey {
  userId: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  certificateId?: string;
  createdAt: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'userId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const loadKey = (userId: string) => tx<StoredKey | undefined>('readonly', (s) => s.get(userId) as IDBRequest<StoredKey | undefined>);
export const saveKey = (k: StoredKey) => tx('readwrite', (s) => s.put(k));
export const deleteKey = (userId: string) => tx('readwrite', (s) => s.delete(userId));
