import * as sdk from '@matrix-org/matrix-sdk-crypto-wasm';
import { unwrapSecret, wrapSecret, type WrappedSecret } from './passphrase';
import type { E2eeTransport } from './transport';

const BACKUP_SECRET = 'backup_key';
const BACKUP_ALGORITHM = 'm.megolm_backup.v1.curve25519-aes-sha2';
const MESSAGE_TYPE = 'm.room.message';

let ready: Promise<void> | undefined;
/** Loads the vodozemac WebAssembly module once. */
export function initCrypto(): Promise<void> {
  return (ready ??= sdk.initAsync());
}

export interface EncryptedForChannel {
  /** Base64 payload for `POST /channels/:id/messages` ({ ciphertext, scheme: 'MEGOLM' }). */
  ciphertext: string;
  scheme: 'MEGOLM';
}

export interface IncomingEncrypted {
  id: string;
  channelId: string;
  /** The sender's user UUID (as returned by the API). */
  senderId: string;
  createdAt: string;
  ciphertext: string;
}

export interface DecryptedMessage {
  content: Record<string, unknown>;
  senderDeviceId: string | undefined;
  /** False when the sending device is not verified (show a warning shield). */
  verified: boolean;
}

export interface PulseCryptoOptions {
  /** User UUID and server name: the E2EE id is "@<uuid>:<serverName>". */
  userId: string;
  serverName: string;
  /** Device id returned by POST /e2ee/devices. */
  deviceId: string;
  transport: E2eeTransport;
  /** Browser: IndexedDB store name and passphrase. Omit for an in-memory store. */
  storeName?: string;
  storePassphrase?: string;
}

/**
 * Client-side E2EE for PUET.Pulse. All cryptography is done by vodozemac inside
 * the official matrix-sdk-crypto (Olm = Double Ratchet over X25519 for device
 * sessions, Megolm for channel messages). Private keys never leave this object's
 * store; the server receives only public keys, signatures and ciphertext.
 */
export class PulseCrypto {
  private since: string | undefined;

  private constructor(
    readonly machine: sdk.OlmMachine,
    private readonly transport: E2eeTransport,
    private readonly serverName: string,
  ) {}

  static async create(o: PulseCryptoOptions): Promise<PulseCrypto> {
    await initCrypto();
    const machine = await sdk.OlmMachine.initialize(
      new sdk.UserId(`@${o.userId}:${o.serverName}`),
      new sdk.DeviceId(o.deviceId),
      o.storeName,
      o.storePassphrase,
    );
    const client = new PulseCrypto(machine, o.transport, o.serverName);
    await client.flush();
    return client;
  }

  mxid(userId: string): string {
    return `@${userId}:${this.serverName}`;
  }

  roomId(channelId: string): sdk.RoomId {
    return new sdk.RoomId(`!${channelId}:${this.serverName}`);
  }

  /** Sends every pending request (key uploads, queries, claims, to-device, backups). */
  async flush(): Promise<void> {
    for (let round = 0; round < 10; round++) {
      const requests = await this.machine.outgoingRequests();
      if (requests.length === 0) return;
      for (const r of requests) await this.send(r);
    }
  }

  /** Pulls to-device envelopes and device-list changes for this device. Call on `e2ee.*` socket events. */
  async sync(): Promise<void> {
    const res = await this.transport.sync(this.since);
    const counts = new Map(Object.entries(res.device_one_time_keys_count));
    await this.machine.receiveSyncChanges(
      JSON.stringify(res.to_device.events),
      new sdk.DeviceLists(
        res.device_lists.changed.map((u) => new sdk.UserId(u)),
        res.device_lists.left.map((u) => new sdk.UserId(u)),
      ),
      counts,
      new Set(res.device_unused_fallback_key_types),
    );
    this.since = res.next_batch;
    await this.flush();
  }

  /**
   * Encrypts a message for a channel. `memberIds` are the user UUIDs from
   * GET /channels/:id/members; the Megolm session key is shared with all their
   * devices over Olm before the message is encrypted.
   */
  async encrypt(channelId: string, memberIds: string[], content: Record<string, unknown>): Promise<EncryptedForChannel> {
    // wasm-bindgen moves objects passed in arrays, so each call gets fresh ids.
    const users = () => memberIds.map((id) => new sdk.UserId(this.mxid(id)));
    await this.machine.updateTrackedUsers(users());
    await this.flush();
    const claim = await this.machine.getMissingSessions(users());
    if (claim) await this.send(claim);

    const room = this.roomId(channelId);
    const settings = new sdk.EncryptionSettings();
    settings.historyVisibility = sdk.HistoryVisibility.Joined;
    for (const r of await this.machine.shareRoomKey(room, users(), settings)) await this.send(r);

    const encrypted = await this.machine.encryptRoomEvent(room, MESSAGE_TYPE, JSON.stringify(content));
    await this.flush();
    return { ciphertext: b64encode(encrypted), scheme: 'MEGOLM' };
  }

  async decrypt(m: IncomingEncrypted): Promise<DecryptedMessage> {
    const event = {
      type: 'm.room.encrypted',
      event_id: `$${m.id}`,
      sender: this.mxid(m.senderId),
      origin_server_ts: Date.parse(m.createdAt),
      room_id: `!${m.channelId}:${this.serverName}`,
      content: JSON.parse(b64decode(m.ciphertext)) as unknown,
    };
    const decrypted = await this.machine.decryptRoomEvent(
      JSON.stringify(event),
      this.roomId(m.channelId),
      new sdk.DecryptionSettings(sdk.TrustRequirement.Untrusted),
    );
    const plain = JSON.parse(decrypted.event) as { content: Record<string, unknown> };
    return {
      content: plain.content,
      senderDeviceId: decrypted.senderDevice?.toString(),
      verified: decrypted.shieldState(true).color === sdk.ShieldColor.None,
    };
  }

  /** After a member leaves: the next message starts a new Megolm session they never receive. */
  async rotate(channelId: string): Promise<void> {
    await this.machine.invalidateGroupSession(this.roomId(channelId));
  }

  // ───────────────────── Key backup under a master passphrase ─────────────────────

  /**
   * Creates a server-side key backup. Room keys are encrypted to a fresh backup
   * key pair; the private half is wrapped under the master passphrase on this
   * device and stored as an opaque secret.
   */
  async enableBackup(passphrase: string): Promise<string> {
    const key = sdk.BackupDecryptionKey.createRandomKey();
    const publicKey = key.megolmV1PublicKey.publicKeyBase64;
    const { version } = await this.transport.createBackupVersion(
      JSON.stringify({ algorithm: BACKUP_ALGORITHM, auth_data: { public_key: publicKey } }),
    );
    const wrapped = await wrapSecret(JSON.stringify({ key: key.toBase64(), version }), passphrase);
    await this.transport.putSecret(BACKUP_SECRET, wrapped);
    await this.machine.saveBackupDecryptionKey(key, version);
    await this.machine.enableBackupV1(publicKey, version);
    await this.backupNow();
    return version;
  }

  /** Uploads room keys that are not in the backup yet. */
  async backupNow(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const req = await this.machine.backupRoomKeys();
      if (!req) return;
      await this.send(req);
    }
  }

  /** On a new device: unwraps the backup key with the passphrase and imports every backed-up room key. */
  async restoreBackup(passphrase: string): Promise<number> {
    const wrapped = (await this.transport.getSecret(BACKUP_SECRET)) as WrappedSecret | null;
    if (!wrapped) throw new Error('No key backup');
    const { key: keyB64, version } = JSON.parse(await unwrapSecret(wrapped, passphrase)) as { key: string; version: string };
    const current = await this.transport.currentBackupVersion();
    if (!current || current.version !== version) throw new Error('The key backup was replaced; use its new passphrase');

    const key = sdk.BackupDecryptionKey.fromBase64(keyB64);
    if (current.auth_data.public_key !== key.megolmV1PublicKey.publicKeyBase64) throw new Error('Backup key mismatch');

    const body = JSON.parse(await this.transport.getBackupKeys(version)) as {
      rooms: Record<string, { sessions: Record<string, { session_data: { ephemeral: string; mac: string; ciphertext: string } }> }>;
    };
    const byRoom = new Map<sdk.RoomId, Map<string, unknown>>();
    for (const [roomId, { sessions }] of Object.entries(body.rooms)) {
      const map = new Map<string, unknown>();
      for (const [sessionId, s] of Object.entries(sessions)) {
        const d = s.session_data;
        map.set(sessionId, JSON.parse(key.decryptV1(d.ephemeral, d.mac, d.ciphertext)));
      }
      byRoom.set(new sdk.RoomId(roomId), map);
    }
    const result = await this.machine.importBackedUpRoomKeys(byRoom, () => undefined, version);
    await this.machine.saveBackupDecryptionKey(key, version);
    await this.machine.enableBackupV1(key.megolmV1PublicKey.publicKeyBase64, version);
    return result.importedCount;
  }

  // ───────────────────────────── QR device verification ─────────────────────────────

  /** Starts verification of another device of the same user (e.g. the new laptop scans the phone's QR code). */
  async requestOwnDeviceVerification(otherDeviceId: string): Promise<sdk.VerificationRequest> {
    const device = await this.machine.getDevice(this.machine.userId, new sdk.DeviceId(otherDeviceId));
    if (!device) throw new Error('Unknown device');
    const [request, toDevice] = device.requestVerification([
      sdk.VerificationMethod.QrCodeScanV1,
      sdk.VerificationMethod.QrCodeShowV1,
      sdk.VerificationMethod.ReciprocateV1,
    ]);
    await this.send(toDevice);
    return request;
  }

  pendingVerification(flowOwnerUserId: string): sdk.VerificationRequest | undefined {
    return this.machine.getVerificationRequests(new sdk.UserId(flowOwnerUserId)).find((r) => !r.isDone() && !r.isCancelled());
  }

  async acceptVerification(request: sdk.VerificationRequest): Promise<void> {
    const out = request.acceptWithMethods([
      sdk.VerificationMethod.QrCodeScanV1,
      sdk.VerificationMethod.QrCodeShowV1,
      sdk.VerificationMethod.ReciprocateV1,
    ]);
    if (out) await this.send(out);
  }

  /** Bytes to render as the QR code on the showing device. */
  async showQr(request: sdk.VerificationRequest): Promise<Uint8ClampedArray> {
    const qr = await request.generateQrCode();
    if (!qr) throw new Error('QR verification is not available for this request');
    return qr.toBytes();
  }

  /** On the scanning device: scan the bytes and confirm to the other side. */
  async scanQr(request: sdk.VerificationRequest, bytes: Uint8ClampedArray): Promise<sdk.Qr> {
    const qr = await request.scanQrCode(sdk.QrCodeScan.fromBytes(bytes));
    const out = qr.reciprocate();
    if (out) await this.send(out);
    return qr;
  }

  /** On the showing device: the user confirms that the other screen shows success. */
  async confirmScanned(qr: sdk.Qr): Promise<void> {
    const out = qr.confirmScanning();
    if (out) await this.send(out);
    await this.flush();
  }

  async bootstrapCrossSigning(): Promise<void> {
    const r = await this.machine.bootstrapCrossSigning(true);
    if (r.uploadKeysRequest) await this.send(r.uploadKeysRequest);
    await this.transport.uploadSigningKeys(r.uploadSigningKeysRequest.body);
    await this.send(r.uploadSignaturesRequest);
    await this.flush();
  }

  async isDeviceVerified(userId: string, deviceId: string): Promise<boolean> {
    const device = await this.machine.getDevice(new sdk.UserId(this.mxid(userId)), new sdk.DeviceId(deviceId));
    return device?.isVerified() ?? false;
  }

  close(): void {
    this.machine.close();
  }

  // ───────────────────────────── Request dispatch ─────────────────────────────

  private async send(r: { readonly type: sdk.RequestType; readonly id?: string | undefined; readonly body: string }): Promise<void> {
    let response: string;
    switch (r.type) {
      case sdk.RequestType.KeysUpload:
        response = await this.transport.uploadKeys(r.body);
        break;
      case sdk.RequestType.KeysQuery:
        response = await this.transport.queryKeys(r.body);
        break;
      case sdk.RequestType.KeysClaim:
        response = await this.transport.claimKeys(r.body);
        break;
      case sdk.RequestType.ToDevice: {
        const t = r as unknown as sdk.ToDeviceRequest;
        response = await this.transport.sendToDevice(t.event_type, t.txn_id, t.body);
        break;
      }
      case sdk.RequestType.SignatureUpload:
        response = await this.transport.uploadSignatures(r.body);
        break;
      case sdk.RequestType.KeysBackup: {
        const b = r as unknown as sdk.KeysBackupRequest;
        response = await this.transport.putBackupKeys(b.version, b.body);
        break;
      }
      default:
        // Room-message verification is not used: PUET.Pulse verifies devices over to-device only.
        throw new Error(`Unsupported E2EE request type ${String(r.type)}`);
    }
    if (r.id) await this.machine.markRequestAsSent(r.id, r.type, response);
  }
}

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
}
