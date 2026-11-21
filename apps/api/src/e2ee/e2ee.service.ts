import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@puet/database';
import type { Principal } from '@puet/policy-engine';
import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime.bus';
import type {
  backupKeysInput,
  backupVersionInput,
  deviceSigningUpload,
  keysClaim,
  keysQuery,
  keysUpload,
  sendToDevice,
  signaturesUpload,
} from './e2ee.schemas';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_DEVICES = 20;
const MAX_TO_DEVICE_BYTES = 64 * 1024;
/** Device-list changes are reported with a small overlap so none is missed. */
const CHANGE_OVERLAP_MS = 5_000;

type Json = Prisma.InputJsonValue;
type Usage = 'master' | 'self_signing' | 'user_signing';

/**
 * E2EE key directory and device-to-device router (vodozemac Olm / Megolm).
 *
 * The server only ever sees public keys, signatures and opaque ciphertext.
 * Zero trust: a user can fetch keys of, claim one-time keys of, and send
 * envelopes to only themselves and people they share an encrypted channel with.
 * Everything else is silently dropped, so ids cannot be probed.
 */
@Injectable()
export class E2eeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ───────────────────────────── Identifiers ─────────────────────────────

  mxid(userId: string): string {
    return `@${userId}:${this.config.e2ee.serverName}`;
  }

  roomId(channelId: string): string {
    return `!${channelId}:${this.config.e2ee.serverName}`;
  }

  /** "@<uuid>:<our server>" -> uuid, or null for anything else. */
  userIdOf(mxid: string): string | null {
    const m = /^@([0-9a-f-]{36}):(.+)$/.exec(mxid);
    return m && m[2] === this.config.e2ee.serverName && UUID_RE.test(m[1]!) ? m[1]! : null;
  }

  // ───────────────────────────── Devices ─────────────────────────────

  async registerDevice(principal: Principal, label: string) {
    const active = await this.prisma.device.count({ where: { userId: principal.userId, revokedAt: null } });
    if (active >= MAX_DEVICES) throw new BadRequestException(`At most ${MAX_DEVICES} devices; remove an old one first`);
    const device = await this.prisma.device.create({ data: { userId: principal.userId, label }, select: { id: true } });
    await this.audit.record({
      actorId: principal.userId,
      tenantId: principal.tenantId,
      action: 'device.register',
      resourceType: 'device',
      resourceId: device.id,
      outcome: 'SUCCESS',
    });
    return { deviceId: device.id, userId: this.mxid(principal.userId) };
  }

  async listDevices(principal: Principal) {
    const rows = await this.prisma.device.findMany({
      where: { userId: principal.userId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, label: true, createdAt: true, lastSeenAt: true, verifiedAt: true, deviceKeys: true },
    });
    return rows.map(({ deviceKeys, ...d }) => ({ ...d, hasKeys: deviceKeys !== null }));
  }

  async revokeDevice(principal: Principal, deviceId: string) {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.device.update({ where: { id: deviceId }, data: { revokedAt: now, keysUpdatedAt: now } }),
      this.prisma.deviceOneTimeKey.deleteMany({ where: { deviceId } }),
      this.prisma.toDeviceMessage.deleteMany({ where: { recipientDeviceId: deviceId } }),
    ]);
    await this.audit.record({
      actorId: principal.userId,
      tenantId: principal.tenantId,
      action: 'device.revoke',
      resourceType: 'device',
      resourceId: deviceId,
      outcome: 'SUCCESS',
    });
    await this.notifyDeviceChange(principal.userId);
    return { deviceId, revoked: true };
  }

  // ───────────────────────────── Keys ─────────────────────────────

  async uploadKeys(principal: Principal, deviceId: string, input: z.infer<typeof keysUpload>) {
    if (input.device_keys) {
      const dk = input.device_keys;
      if (dk.user_id !== this.mxid(principal.userId) || dk.device_id !== deviceId) {
        throw new BadRequestException('device_keys must describe the authenticated user and device');
      }
      if (!dk.keys[`ed25519:${deviceId}`] || !dk.keys[`curve25519:${deviceId}`]) {
        throw new BadRequestException('device_keys must contain ed25519 and curve25519 keys of this device');
      }
      const current = await this.prisma.device.findUniqueOrThrow({ where: { id: deviceId }, select: { deviceKeys: true } });
      const stored = current.deviceKeys as { keys?: unknown; signatures?: Record<string, Record<string, string>> } | null;
      if (stored && !isDeepStrictEqual(stored.keys, dk.keys)) {
        // Identity keys of a device are fixed; a new key pair means a new device.
        throw new BadRequestException('Device keys cannot change; register a new device');
      }
      const merged = { ...dk, signatures: mergeSignatures(stored?.signatures, dk.signatures) };
      if (!stored || !isDeepStrictEqual(stored, merged)) {
        await this.prisma.device.update({
          where: { id: deviceId },
          data: { deviceKeys: merged as Json, keysUpdatedAt: new Date() },
        });
        await this.notifyDeviceChange(principal.userId);
      }
    }

    if (input.one_time_keys) {
      await this.prisma.deviceOneTimeKey.createMany({
        data: Object.entries(input.one_time_keys).map(([keyId, key]) => ({
          deviceId,
          keyId,
          algorithm: keyId.split(':')[0]!,
          key: key as Json,
          fallback: false,
        })),
        skipDuplicates: true,
      });
    }

    if (input.fallback_keys) {
      for (const [keyId, key] of Object.entries(input.fallback_keys)) {
        const algorithm = keyId.split(':')[0]!;
        await this.prisma.$transaction([
          this.prisma.deviceOneTimeKey.deleteMany({ where: { deviceId, algorithm, fallback: true } }),
          this.prisma.deviceOneTimeKey.create({ data: { deviceId, keyId, algorithm, key: key as Json, fallback: true } }),
        ]);
      }
    }

    await this.prisma.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
    return { one_time_key_counts: await this.oneTimeKeyCounts(deviceId) };
  }

  async queryKeys(principal: Principal, input: z.infer<typeof keysQuery>) {
    const requested = new Map<string, { mxid: string; devices: string[] }>();
    for (const [mxid, devices] of Object.entries(input.device_keys)) {
      const id = this.userIdOf(mxid);
      if (id) requested.set(id, { mxid, devices });
    }
    const allowed = await this.visibleUsers(principal.userId, [...requested.keys()]);

    const device_keys: Record<string, Record<string, unknown>> = {};
    const master_keys: Record<string, unknown> = {};
    const self_signing_keys: Record<string, unknown> = {};
    const user_signing_keys: Record<string, unknown> = {};
    if (allowed.length === 0) return { device_keys, master_keys, self_signing_keys, user_signing_keys, failures: {} };

    const [devices, crossKeys] = await Promise.all([
      this.prisma.device.findMany({
        where: { userId: { in: allowed }, revokedAt: null, NOT: { deviceKeys: { equals: Prisma.DbNull } } },
        select: { id: true, userId: true, deviceKeys: true, label: true },
      }),
      this.prisma.crossSigningKey.findMany({ where: { userId: { in: allowed } } }),
    ]);
    for (const userId of allowed) device_keys[this.mxid(userId)] = {};
    for (const d of devices) {
      const want = requested.get(d.userId)!.devices;
      if (want.length > 0 && !want.includes(d.id)) continue;
      const keys = { ...(d.deviceKeys as Record<string, unknown>) };
      // Device names are visible to their owner only.
      keys.unsigned = d.userId === principal.userId ? { device_display_name: d.label } : {};
      device_keys[this.mxid(d.userId)]![d.id] = keys;
    }
    for (const k of crossKeys) {
      const mx = this.mxid(k.userId);
      if (k.usage === 'master') master_keys[mx] = k.key;
      else if (k.usage === 'self_signing') self_signing_keys[mx] = k.key;
      else if (k.usage === 'user_signing' && k.userId === principal.userId) user_signing_keys[mx] = k.key;
    }
    return { device_keys, master_keys, self_signing_keys, user_signing_keys, failures: {} };
  }

  async claimKeys(principal: Principal, input: z.infer<typeof keysClaim>) {
    const wanted = new Map<string, Record<string, string>>();
    for (const [mxid, devices] of Object.entries(input.one_time_keys)) {
      const id = this.userIdOf(mxid);
      if (id) wanted.set(id, devices);
    }
    const allowed = new Set(await this.visibleUsers(principal.userId, [...wanted.keys()]));
    const one_time_keys: Record<string, Record<string, Record<string, unknown>>> = {};

    for (const [userId, devices] of wanted) {
      if (!allowed.has(userId)) continue;
      const validIds = Object.keys(devices).filter((d) => UUID_RE.test(d));
      const owned = await this.prisma.device.findMany({
        where: { id: { in: validIds }, userId, revokedAt: null },
        select: { id: true },
      });
      for (const { id: deviceId } of owned) {
        const algorithm = devices[deviceId]!;
        const taken = await this.prisma.$queryRaw<{ key_id: string; key: unknown }[]>`
          DELETE FROM device_one_time_keys
          WHERE id = (
            SELECT id FROM device_one_time_keys
            WHERE device_id = ${deviceId}::uuid AND algorithm = ${algorithm} AND fallback = false
            ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
          )
          RETURNING key_id, key`;
        let row = taken[0];
        if (!row) {
          const fb = await this.prisma.deviceOneTimeKey.findFirst({
            where: { deviceId, algorithm, fallback: true },
            select: { keyId: true, key: true },
          });
          if (fb) row = { key_id: fb.keyId, key: fb.key };
        }
        if (!row) continue;
        const mx = this.mxid(userId);
        ((one_time_keys[mx] ??= {})[deviceId] ??= {})[row.key_id] = row.key;
      }
    }
    return { one_time_keys, failures: {} };
  }

  async uploadDeviceSigning(principal: Principal, input: z.infer<typeof deviceSigningUpload>, replace: boolean) {
    const me = this.mxid(principal.userId);
    const entries: [Usage, z.infer<typeof deviceSigningUpload>['master_key']][] = [
      ['master', input.master_key],
      ['self_signing', input.self_signing_key],
      ['user_signing', input.user_signing_key],
    ];
    const existingMaster = await this.prisma.crossSigningKey.findUnique({
      where: { userId_usage: { userId: principal.userId, usage: 'master' } },
    });
    if (input.master_key && existingMaster && !isDeepStrictEqual((existingMaster.key as { keys?: unknown }).keys, input.master_key.keys) && !replace) {
      throw new ForbiddenException('Cross-signing keys already exist; resetting them needs replace=true');
    }
    for (const [usage, key] of entries) {
      if (!key) continue;
      if (key.user_id !== me || key.usage[0] !== usage) throw new BadRequestException(`Invalid ${usage} key`);
      await this.prisma.crossSigningKey.upsert({
        where: { userId_usage: { userId: principal.userId, usage } },
        create: { userId: principal.userId, usage, key: key as Json },
        update: { key: key as Json },
      });
    }
    await this.audit.record({
      actorId: principal.userId,
      tenantId: principal.tenantId,
      action: existingMaster ? 'e2ee.cross_signing.reset' : 'e2ee.cross_signing.setup',
      resourceType: 'device',
      outcome: 'SUCCESS',
    });
    await this.notifyDeviceChange(principal.userId);
    return {};
  }

  /**
   * Stores signatures that the user's own devices made over their own keys
   * (QR verification of a new device, cross-signing). Only the `signatures`
   * field is taken; the signed key material must equal what is stored.
   */
  async uploadSignatures(principal: Principal, input: z.infer<typeof signaturesUpload>) {
    const me = this.mxid(principal.userId);
    const failures: Record<string, Record<string, { errcode: string; error: string }>> = {};
    const fail = (mx: string, key: string, error: string) => ((failures[mx] ??= {})[key] = { errcode: 'M_INVALID_SIGNATURE', error });

    for (const [mx, keys] of Object.entries(input)) {
      for (const [keyId, signed] of Object.entries(keys)) {
        if (mx !== me) {
          fail(mx, keyId, 'Signatures of other users are kept on the signing device only');
          continue;
        }
        const sigs = (signed as { signatures?: Record<string, Record<string, string>> }).signatures;
        if (!sigs || typeof sigs !== 'object') {
          fail(mx, keyId, 'Missing signatures');
          continue;
        }
        if (UUID_RE.test(keyId)) {
          const device = await this.prisma.device.findFirst({
            where: { id: keyId, userId: principal.userId, revokedAt: null },
            select: { deviceKeys: true },
          });
          const stored = device?.deviceKeys as { keys?: unknown; signatures?: Record<string, Record<string, string>> } | null;
          if (!stored || !isDeepStrictEqual(stored.keys, (signed as { keys?: unknown }).keys)) {
            fail(mx, keyId, 'Unknown device or key mismatch');
            continue;
          }
          await this.prisma.device.update({
            where: { id: keyId },
            data: { deviceKeys: { ...stored, signatures: mergeSignatures(stored.signatures, sigs) } as Json, keysUpdatedAt: new Date() },
          });
        } else {
          const master = await this.prisma.crossSigningKey.findUnique({
            where: { userId_usage: { userId: principal.userId, usage: 'master' } },
          });
          const stored = master?.key as { keys?: Record<string, string>; signatures?: Record<string, Record<string, string>> } | undefined;
          if (!stored || !stored.keys || !Object.values(stored.keys).includes(keyId) || !isDeepStrictEqual(stored.keys, (signed as { keys?: unknown }).keys)) {
            fail(mx, keyId, 'Unknown key');
            continue;
          }
          await this.prisma.crossSigningKey.update({
            where: { userId_usage: { userId: principal.userId, usage: 'master' } },
            data: { key: { ...stored, signatures: mergeSignatures(stored.signatures, sigs) } as Json },
          });
        }
      }
    }
    await this.notifyDeviceChange(principal.userId);
    return { failures };
  }

  // ───────────────────────── Device-to-device ─────────────────────────

  async sendToDevice(principal: Principal, senderDeviceId: string, eventType: string, input: z.infer<typeof sendToDevice>) {
    const targets = new Map<string, Record<string, Record<string, unknown>>>();
    for (const [mxid, devices] of Object.entries(input.messages)) {
      const id = this.userIdOf(mxid);
      if (id) targets.set(id, devices);
    }
    const allowed = await this.visibleUsers(principal.userId, [...targets.keys()]);
    const rows: Prisma.ToDeviceMessageCreateManyInput[] = [];

    for (const userId of allowed) {
      const devices = targets.get(userId)!;
      const all = Object.prototype.hasOwnProperty.call(devices, '*');
      const ids = Object.keys(devices).filter((d) => UUID_RE.test(d));
      const recipients = await this.prisma.device.findMany({
        where: { userId, revokedAt: null, ...(all ? {} : { id: { in: ids } }) },
        select: { id: true },
      });
      for (const r of recipients) {
        const content = (all ? devices['*'] : devices[r.id])!;
        if (Buffer.byteLength(JSON.stringify(content)) > MAX_TO_DEVICE_BYTES) {
          throw new BadRequestException('to-device message too large');
        }
        rows.push({
          recipientDeviceId: r.id,
          senderUserId: principal.userId,
          senderDeviceId,
          eventType,
          content: content as Json,
        });
      }
    }
    if (rows.length) {
      await this.prisma.toDeviceMessage.createMany({ data: rows });
      await this.bus.emitToUsers(allowed, 'e2ee.to_device', {});
    }
    return {};
  }

  /** Pull for one device: to-device envelopes (acked by `since`), device list changes, key counts. */
  async sync(principal: Principal, deviceId: string, q: { since?: string; limit: number }) {
    const [ackId, sinceTs] = q.since ? q.since.split('_').map((n) => BigInt(n)) : [0n, 0n];
    const startedAt = Date.now();
    if (ackId! > 0n) {
      await this.prisma.toDeviceMessage.deleteMany({ where: { recipientDeviceId: deviceId, id: { lte: ackId! } } });
    }
    const events = await this.prisma.toDeviceMessage.findMany({
      where: { recipientDeviceId: deviceId, id: { gt: ackId! } },
      orderBy: { id: 'asc' },
      take: q.limit,
    });

    let changed: string[] = [];
    if (sinceTs! > 0n) {
      const since = new Date(Number(sinceTs) - CHANGE_OVERLAP_MS);
      const rows = await this.prisma.$queryRaw<{ user_id: string }[]>`
        WITH peers AS (
          SELECT ${principal.userId}::uuid AS user_id
          UNION
          SELECT b.user_id FROM channel_members a
          JOIN channel_members b ON b.channel_id = a.channel_id
          JOIN channels c ON c.id = a.channel_id
          WHERE a.user_id = ${principal.userId}::uuid AND c.e2ee_mode <> 'DISABLED'
        )
        SELECT DISTINCT p.user_id::text AS user_id FROM peers p
        WHERE EXISTS (SELECT 1 FROM devices d WHERE d.user_id = p.user_id AND d.keys_updated_at > ${since})
           OR EXISTS (SELECT 1 FROM cross_signing_keys k WHERE k.user_id = p.user_id AND k.updated_at > ${since})`;
      changed = rows.map((r) => this.mxid(r.user_id));
    }

    await this.prisma.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
    const fallbacks = await this.prisma.deviceOneTimeKey.findMany({
      where: { deviceId, fallback: true },
      select: { algorithm: true },
    });
    const lastId = events.at(-1)?.id ?? ackId!;
    return {
      next_batch: `${lastId}_${startedAt}`,
      to_device: {
        events: events.map((e) => ({ type: e.eventType, sender: this.mxid(e.senderUserId), content: e.content })),
      },
      device_lists: { changed, left: [] as string[] },
      device_one_time_keys_count: await this.oneTimeKeyCounts(deviceId),
      device_unused_fallback_key_types: [...new Set(fallbacks.map((f) => f.algorithm))],
    };
  }

  // ───────────────────────────── Key backup ─────────────────────────────

  async createBackupVersion(principal: Principal, input: z.infer<typeof backupVersionInput>) {
    const version = await this.prisma.$transaction(async (tx) => {
      await tx.keyBackupVersion.updateMany({
        where: { userId: principal.userId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      return tx.keyBackupVersion.create({
        data: { userId: principal.userId, algorithm: input.algorithm, authData: input.auth_data as Json },
        select: { id: true },
      });
    });
    await this.audit.record({
      actorId: principal.userId,
      tenantId: principal.tenantId,
      action: 'e2ee.backup.create',
      resourceType: 'device',
      resourceId: version.id,
      outcome: 'SUCCESS',
    });
    return { version: version.id };
  }

  async currentBackup(principal: Principal) {
    const v = await this.prisma.keyBackupVersion.findFirst({
      where: { userId: principal.userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { sessions: true } } },
    });
    if (!v) throw new NotFoundException('No backup');
    return { version: v.id, algorithm: v.algorithm, auth_data: v.authData, etag: String(v.etag), count: v._count.sessions };
  }

  async putBackupKeys(principal: Principal, version: string, input: z.infer<typeof backupKeysInput>) {
    const v = await this.ownCurrentVersion(principal, version);
    for (const [roomId, { sessions }] of Object.entries(input.rooms)) {
      for (const [sessionId, data] of Object.entries(sessions)) {
        await this.prisma.keyBackupSession.upsert({
          where: { versionId_roomId_sessionId: { versionId: v.id, roomId, sessionId } },
          create: { versionId: v.id, roomId, sessionId, data: data as Json },
          update: { data: data as Json },
        });
      }
    }
    const updated = await this.prisma.keyBackupVersion.update({
      where: { id: v.id },
      data: { etag: { increment: 1 } },
      include: { _count: { select: { sessions: true } } },
    });
    return { etag: String(updated.etag), count: updated._count.sessions };
  }

  async getBackupKeys(principal: Principal, version: string) {
    const v = await this.ownCurrentVersion(principal, version);
    const rows = await this.prisma.keyBackupSession.findMany({ where: { versionId: v.id } });
    const rooms: Record<string, { sessions: Record<string, unknown> }> = {};
    for (const r of rows) (rooms[r.roomId] ??= { sessions: {} }).sessions[r.sessionId] = r.data;
    return { rooms };
  }

  async putSecret(principal: Principal, name: string, ciphertext: Record<string, unknown>) {
    await this.prisma.userSecret.upsert({
      where: { userId_name: { userId: principal.userId, name } },
      create: { userId: principal.userId, name, ciphertext: ciphertext as Json },
      update: { ciphertext: ciphertext as Json },
    });
    return {};
  }

  async getSecret(principal: Principal, name: string) {
    const s = await this.prisma.userSecret.findUnique({ where: { userId_name: { userId: principal.userId, name } } });
    if (!s) throw new NotFoundException();
    return { ciphertext: s.ciphertext };
  }

  // ───────────────────────────── Helpers ─────────────────────────────

  /** Self plus active users who share a non-DISABLED (encrypted) channel with the caller. */
  async visibleUsers(me: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const others = ids.filter((id) => id !== me);
    const rows = others.length
      ? await this.prisma.$queryRaw<{ id: string }[]>`
          SELECT DISTINCT b.user_id::text AS id
          FROM channel_members a
          JOIN channel_members b ON b.channel_id = a.channel_id
          JOIN channels c ON c.id = a.channel_id
          JOIN users u ON u.id = b.user_id
          WHERE a.user_id = ${me}::uuid
            AND b.user_id = ANY(${others}::uuid[])
            AND c.e2ee_mode <> 'DISABLED'
            AND u.status = 'ACTIVE'
            AND (a.expires_at IS NULL OR a.expires_at > now())
            AND (b.expires_at IS NULL OR b.expires_at > now())`
      : [];
    return [...(ids.includes(me) ? [me] : []), ...rows.map((r) => r.id)];
  }

  private async oneTimeKeyCounts(deviceId: string): Promise<Record<string, number>> {
    const counts = await this.prisma.deviceOneTimeKey.groupBy({
      by: ['algorithm'],
      where: { deviceId, fallback: false },
      _count: { _all: true },
    });
    return Object.fromEntries(counts.map((c) => [c.algorithm, c._count._all]));
  }

  private async ownCurrentVersion(principal: Principal, version: string) {
    const v = await this.prisma.keyBackupVersion.findFirst({
      where: { userId: principal.userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!v) throw new NotFoundException('No backup');
    if (v.id !== version) throw new ForbiddenException('Backup version is not current');
    return v;
  }

  /** Tells the user's own devices and E2EE peers to re-query keys. */
  private async notifyDeviceChange(userId: string) {
    const peers = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT b.user_id::text AS id FROM channel_members a
      JOIN channel_members b ON b.channel_id = a.channel_id
      JOIN channels c ON c.id = a.channel_id
      WHERE a.user_id = ${userId}::uuid AND c.e2ee_mode <> 'DISABLED'`;
    await this.bus.emitToUsers([userId, ...peers.map((p) => p.id)], 'e2ee.devices_changed', { userId: this.mxid(userId) });
  }
}

function mergeSignatures(
  a: Record<string, Record<string, string>> | undefined,
  b: Record<string, Record<string, string>> | undefined,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const src of [a ?? {}, b ?? {}]) {
    for (const [user, sigs] of Object.entries(src)) out[user] = { ...(out[user] ?? {}), ...sigs };
  }
  return out;
}
