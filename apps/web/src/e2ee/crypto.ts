import type { PulseCrypto as PulseCryptoType } from '@puet/e2ee';
import { api, API_BASE } from '../api/client';

/**
 * This browser's E2EE device. vodozemac (via the official matrix-sdk-crypto
 * WebAssembly build) is loaded lazily, only when the user opens an encrypted
 * chat, and keeps its private keys in IndexedDB. The server only ever sees
 * public keys, signatures and ciphertext (CLAUDE.md §1.2).
 */
let current: { userId: string; crypto: Promise<PulseCryptoType> } | null = null;

const deviceKey = (userId: string) => `pulse.e2ee.device.${userId}`;
const storeKey = (userId: string) => `pulse.e2ee.store.${userId}`;

function randomSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b));
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `PUET.Pulse Web · ${browser}`;
}

async function create(userId: string): Promise<PulseCryptoType> {
  const { PulseCrypto, HttpTransport } = await import('@puet/e2ee');
  const who = await api<{ userId: string }>('/e2ee/whoami');
  const serverName = who.userId.split(':').slice(1).join(':');

  let deviceId = localStorage.getItem(deviceKey(userId));
  if (deviceId) {
    const devices = await api<{ id: string }[]>('/e2ee/devices');
    if (!devices.some((d) => d.id === deviceId)) deviceId = null;
  }
  if (!deviceId) {
    deviceId = (await api<{ deviceId: string }>('/e2ee/devices', { method: 'POST', body: { label: deviceLabel() } })).deviceId;
    localStorage.setItem(deviceKey(userId), deviceId);
  }
  // Random per-device secret that encrypts the IndexedDB store at rest.
  let storePassphrase = localStorage.getItem(storeKey(userId));
  if (!storePassphrase) {
    storePassphrase = randomSecret();
    localStorage.setItem(storeKey(userId), storePassphrase);
  }
  return PulseCrypto.create({
    userId,
    serverName,
    deviceId,
    transport: new HttpTransport(API_BASE, deviceId),
    storeName: `pulse-e2ee-${userId}`,
    storePassphrase,
  });
}

export function getCrypto(userId: string): Promise<PulseCryptoType> {
  if (current?.userId !== userId) {
    const p = create(userId);
    current = { userId, crypto: p };
    p.catch(() => {
      if (current?.crypto === p) current = null;
    });
  }
  return current.crypto;
}

export const cryptoStarted = (userId: string) => current?.userId === userId;

export function currentDeviceId(userId: string): string | null {
  try {
    return localStorage.getItem(deviceKey(userId));
  } catch {
    return null;
  }
}
