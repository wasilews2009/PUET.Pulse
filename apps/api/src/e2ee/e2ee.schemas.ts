import { z } from 'zod';

/**
 * Wire format of the E2EE key directory. It follows the Matrix client-server
 * key API, which vodozemac's official SDK (matrix-sdk-crypto) speaks. The server
 * stores these public, client-signed objects as-is and verifies only that they
 * belong to the authenticated user and device. Signatures are checked by clients.
 */

const MAX_KEYS_PER_UPLOAD = 100;
const keyId = z.string().regex(/^[A-Za-z0-9_+/=-]{1,32}:[A-Za-z0-9_+/=-]{1,64}$/);
const unpaddedB64 = z.string().regex(/^[A-Za-z0-9+/]{16,128}$/);
const signatures = z.record(z.record(z.string().max(256))).refine((s) => Object.keys(s).length <= 16);

export const deviceKeys = z
  .object({
    user_id: z.string().max(300),
    device_id: z.string().max(64),
    algorithms: z.array(z.string().max(64)).min(1).max(8),
    keys: z.record(keyId, unpaddedB64).refine((k) => Object.keys(k).length >= 2 && Object.keys(k).length <= 8),
    signatures,
    unsigned: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type DeviceKeys = z.infer<typeof deviceKeys>;

const oneTimeKey = z.union([
  unpaddedB64,
  z.object({ key: unpaddedB64, signatures, fallback: z.boolean().optional() }).passthrough(),
]);

export const keysUpload = z
  .object({
    device_keys: deviceKeys.optional(),
    one_time_keys: z
      .record(keyId, oneTimeKey)
      .refine((k) => Object.keys(k).length <= MAX_KEYS_PER_UPLOAD)
      .optional(),
    fallback_keys: z
      .record(keyId, oneTimeKey)
      .refine((k) => Object.keys(k).length <= 8)
      .optional(),
  })
  .strict();

export const keysQuery = z
  .object({
    device_keys: z.record(z.string().max(300), z.array(z.string().max(64)).max(100)),
    timeout: z.number().optional(),
  })
  .strict()
  .refine((q) => Object.keys(q.device_keys).length <= 1000);

export const keysClaim = z
  .object({
    one_time_keys: z.record(z.string().max(300), z.record(z.string().max(64), z.string().max(64))),
    timeout: z.number().optional(),
  })
  .strict()
  .refine((q) => Object.values(q.one_time_keys).reduce((n, d) => n + Object.keys(d).length, 0) <= 1000);

const crossSigningKey = z
  .object({
    user_id: z.string().max(300),
    usage: z.array(z.enum(['master', 'self_signing', 'user_signing'])).length(1),
    keys: z.record(keyId, unpaddedB64).refine((k) => Object.keys(k).length === 1),
    signatures: signatures.optional(),
  })
  .passthrough();
export type CrossSigningKeyJson = z.infer<typeof crossSigningKey>;

export const deviceSigningUpload = z
  .object({
    master_key: crossSigningKey.optional(),
    self_signing_key: crossSigningKey.optional(),
    user_signing_key: crossSigningKey.optional(),
    auth: z.unknown().optional(),
  })
  .strict();

/** userId -> keyId (device id or cross-signing public key) -> signed object. */
export const signaturesUpload = z.record(z.string().max(300), z.record(z.string().max(128), z.record(z.unknown())));

export const sendToDevice = z
  .object({
    messages: z.record(z.string().max(300), z.record(z.string().max(64), z.record(z.unknown()))),
  })
  .strict()
  .refine((b) => Object.values(b.messages).reduce((n, d) => n + Object.keys(d).length, 0) <= 1000);

export const toDeviceEventType = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);
export const txnId = z.string().regex(/^[A-Za-z0-9._~-]{1,64}$/);

export const syncQuery = z
  .object({
    since: z
      .string()
      .regex(/^\d{1,19}_\d{1,15}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

export const registerDevice = z.object({ label: z.string().trim().min(1).max(80) }).strict();

export const backupVersionInput = z
  .object({
    algorithm: z.literal('m.megolm_backup.v1.curve25519-aes-sha2'),
    auth_data: z.record(z.unknown()),
  })
  .strict();

export const backupKeysInput = z
  .object({
    rooms: z.record(
      z.string().max(300),
      z.object({ sessions: z.record(z.string().max(128), z.record(z.unknown())) }).strict(),
    ),
  })
  .strict()
  .refine((b) => Object.values(b.rooms).reduce((n, r) => n + Object.keys(r.sessions).length, 0) <= 1000);

export const secretName = z.string().regex(/^[a-z0-9._-]{1,64}$/);
export const secretInput = z.object({ ciphertext: z.record(z.unknown()) }).strict();
