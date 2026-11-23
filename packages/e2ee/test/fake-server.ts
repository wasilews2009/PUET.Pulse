import type { E2eeTransport, SyncResponse } from '../src/transport';

/**
 * Minimal in-memory key directory used to test the client without the API.
 * It mimics the semantics of /e2ee/* (the real server adds authorization).
 */
export class FakeKeyServer {
  devices = new Map<string, Record<string, unknown>>(); // `${user}|${device}` -> device_keys
  otks = new Map<string, Map<string, unknown>>();
  fallback = new Map<string, Map<string, unknown>>();
  cross = new Map<string, Record<string, unknown>>(); // `${user}|${usage}`
  inbox = new Map<string, { type: string; sender: string; content: unknown }[]>();
  backups: { version: string; auth_data: Record<string, unknown>; rooms: Record<string, { sessions: Record<string, unknown> }> }[] = [];
  secrets = new Map<string, unknown>();

  transport(userMx: string, deviceId: string): E2eeTransport {
    const key = `${userMx}|${deviceId}`;
    const s = this;
    return {
      async uploadKeys(body) {
        const b = JSON.parse(body) as {
          device_keys?: Record<string, unknown>;
          one_time_keys?: Record<string, unknown>;
          fallback_keys?: Record<string, unknown>;
        };
        if (b.device_keys) s.devices.set(key, b.device_keys);
        const m = s.otks.get(key) ?? new Map();
        for (const [k, v] of Object.entries(b.one_time_keys ?? {})) m.set(k, v);
        s.otks.set(key, m);
        if (b.fallback_keys && Object.keys(b.fallback_keys).length) s.fallback.set(key, new Map(Object.entries(b.fallback_keys)));
        return JSON.stringify({ one_time_key_counts: { signed_curve25519: m.size } });
      },
      async queryKeys(body) {
        const q = JSON.parse(body) as { device_keys: Record<string, string[]> };
        const device_keys: Record<string, Record<string, unknown>> = {};
        const master_keys: Record<string, unknown> = {};
        const self_signing_keys: Record<string, unknown> = {};
        const user_signing_keys: Record<string, unknown> = {};
        for (const user of Object.keys(q.device_keys)) {
          device_keys[user] = {};
          for (const [k, v] of s.devices) if (k.startsWith(`${user}|`)) device_keys[user]![k.split('|')[1]!] = v;
          const mk = s.cross.get(`${user}|master`);
          if (mk) master_keys[user] = mk;
          const ssk = s.cross.get(`${user}|self_signing`);
          if (ssk) self_signing_keys[user] = ssk;
          const usk = s.cross.get(`${user}|user_signing`);
          if (usk && user === userMx) user_signing_keys[user] = usk;
        }
        return JSON.stringify({ device_keys, master_keys, self_signing_keys, user_signing_keys, failures: {} });
      },
      async claimKeys(body) {
        const q = JSON.parse(body) as { one_time_keys: Record<string, Record<string, string>> };
        const out: Record<string, Record<string, Record<string, unknown>>> = {};
        for (const [user, devs] of Object.entries(q.one_time_keys)) {
          for (const dev of Object.keys(devs)) {
            const m = s.otks.get(`${user}|${dev}`);
            const first = m && [...m.entries()][0];
            if (first) {
              m!.delete(first[0]);
              ((out[user] ??= {})[dev] ??= {})[first[0]] = first[1];
            }
          }
        }
        return JSON.stringify({ one_time_keys: out, failures: {} });
      },
      async sendToDevice(eventType, _txn, body) {
        const b = JSON.parse(body) as { messages: Record<string, Record<string, unknown>> };
        for (const [user, devs] of Object.entries(b.messages)) {
          for (const [dev, content] of Object.entries(devs)) {
            const targets = dev === '*' ? [...s.devices.keys()].filter((k) => k.startsWith(`${user}|`)) : [`${user}|${dev}`];
            for (const t of targets) {
              const q = s.inbox.get(t) ?? [];
              q.push({ type: eventType, sender: userMx, content });
              s.inbox.set(t, q);
            }
          }
        }
        return '{}';
      },
      async uploadSignatures(body) {
        type Signed = { signatures?: Record<string, Record<string, string>>; keys?: Record<string, string> };
        const merge = (target: Signed, from: Signed) => {
          for (const [u, sigs] of Object.entries(from.signatures ?? {})) {
            target.signatures = { ...(target.signatures ?? {}), [u]: { ...(target.signatures?.[u] ?? {}), ...sigs } };
          }
        };
        const b = JSON.parse(body) as Record<string, Record<string, Signed>>;
        for (const [user, keys] of Object.entries(b)) {
          for (const [keyId, signed] of Object.entries(keys)) {
            const device = s.devices.get(`${user}|${keyId}`) as Signed | undefined;
            if (device) merge(device, signed);
            for (const usage of ['master', 'self_signing', 'user_signing']) {
              const k = s.cross.get(`${user}|${usage}`) as Signed | undefined;
              if (k && Object.values(k.keys ?? {}).includes(keyId)) merge(k, signed);
            }
          }
        }
        return JSON.stringify({ failures: {} });
      },
      async uploadSigningKeys(body) {
        const b = JSON.parse(body) as Record<string, Record<string, unknown> | undefined>;
        if (b.master_key) s.cross.set(`${userMx}|master`, b.master_key);
        if (b.self_signing_key) s.cross.set(`${userMx}|self_signing`, b.self_signing_key);
        if (b.user_signing_key) s.cross.set(`${userMx}|user_signing`, b.user_signing_key);
        return '{}';
      },
      async createBackupVersion(body) {
        const b = JSON.parse(body) as { auth_data: Record<string, unknown> };
        const version = String(s.backups.length + 1);
        s.backups.push({ version, auth_data: b.auth_data, rooms: {} });
        return { version };
      },
      async currentBackupVersion() {
        const b = s.backups.at(-1);
        return b ? { version: b.version, auth_data: b.auth_data } : null;
      },
      async putBackupKeys(version, body) {
        const b = s.backups.find((x) => x.version === version)!;
        const rooms = (JSON.parse(body) as { rooms: Record<string, { sessions: Record<string, unknown> }> }).rooms;
        for (const [r, { sessions }] of Object.entries(rooms)) Object.assign((b.rooms[r] ??= { sessions: {} }).sessions, sessions);
        return JSON.stringify({ etag: '1', count: 1 });
      },
      async getBackupKeys(version) {
        return JSON.stringify({ rooms: s.backups.find((x) => x.version === version)!.rooms });
      },
      async putSecret(name, ciphertext) {
        s.secrets.set(`${userMx}|${name}`, ciphertext);
      },
      async getSecret(name) {
        return s.secrets.get(`${userMx}|${name}`) ?? null;
      },
      async sync(): Promise<SyncResponse> {
        const events = s.inbox.get(key) ?? [];
        s.inbox.set(key, []);
        return {
          next_batch: '0_0',
          to_device: { events },
          // Simplification: report every known user as changed so clients re-query.
          device_lists: { changed: [...new Set([...s.devices.keys()].map((k) => k.split('|')[0]!))], left: [] },
          device_one_time_keys_count: { signed_curve25519: s.otks.get(key)?.size ?? 0 },
          device_unused_fallback_key_types: s.fallback.has(key) ? ['signed_curve25519'] : [],
        };
      },
    };
  }
}
