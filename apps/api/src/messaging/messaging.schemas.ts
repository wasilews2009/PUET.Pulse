import { z } from 'zod';

/** Opaque ciphertext from vodozemac, base64. 256 KiB is far above any text message. */
const MAX_CIPHERTEXT_B64 = 350_000;
export const MAX_BODY = 20_000;
export const ALLOWED_TTL = [3600, 86_400, 604_800] as const;

const base64 = z
  .string()
  .min(1)
  .max(MAX_CIPHERTEXT_B64)
  .regex(/^[A-Za-z0-9+/_-]+={0,2}$/, 'must be base64');

export const sendMessageInput = z
  .object({
    /** Client-generated id that makes retries idempotent. */
    clientMessageId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,64}$/)
      .optional(),
    body: z.string().min(1).max(MAX_BODY).optional(),
    ciphertext: base64.optional(),
    scheme: z.enum(['MEGOLM', 'OLM']).optional(),
    senderDeviceId: z.string().uuid().optional(),
    threadRootId: z.string().uuid().optional(),
  })
  .strict()
  .refine((m) => (m.body === undefined) !== (m.ciphertext === undefined), {
    message: 'exactly one of body or ciphertext is required',
  })
  .refine((m) => m.ciphertext === undefined || (m.scheme !== undefined && m.senderDeviceId !== undefined), {
    message: 'ciphertext requires scheme and senderDeviceId',
  });
export type SendMessageInput = z.infer<typeof sendMessageInput>;

export const editMessageInput = z
  .object({
    body: z.string().min(1).max(MAX_BODY).optional(),
    ciphertext: base64.optional(),
    senderDeviceId: z.string().uuid().optional(),
  })
  .strict()
  .refine((m) => (m.body === undefined) !== (m.ciphertext === undefined), {
    message: 'exactly one of body or ciphertext is required',
  })
  .refine((m) => m.ciphertext === undefined || m.senderDeviceId !== undefined, {
    message: 'ciphertext requires senderDeviceId',
  });
export type EditMessageInput = z.infer<typeof editMessageInput>;

export const historyQuery = z
  .object({
    before: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    threadRootId: z.string().uuid().optional(),
  })
  .strict();

export const readInput = z.object({ messageId: z.string().uuid().optional() }).strict();

export const createGroupInput = z
  .object({
    nameUk: z.string().trim().min(1).max(120),
    nameEn: z.string().trim().min(1).max(120).optional(),
    memberIds: z.array(z.string().uuid()).max(255).default([]),
    /** OPTIONAL E2EE chats are encrypted by the clients when this is true. */
    encrypted: z.boolean().default(true),
    messageTtlSeconds: z.union([z.literal(3600), z.literal(86_400), z.literal(604_800)]).optional(),
  })
  .strict();

export const addMembersInput = z.object({ userIds: z.array(z.string().uuid()).min(1).max(100) }).strict();

export const updateChannelInput = z
  .object({
    nameUk: z.string().trim().min(1).max(120).optional(),
    nameEn: z.string().trim().min(1).max(120).nullable().optional(),
    topic: z.string().trim().max(500).nullable().optional(),
    messageTtlSeconds: z.union([z.literal(3600), z.literal(86_400), z.literal(604_800), z.null()]).optional(),
  })
  .strict();

export const muteInput = z.object({ mutedUntil: z.string().datetime().nullable() }).strict();

export const presenceInput = z
  .object({
    status: z.enum(['ONLINE', 'IN_CLASS', 'IN_COUNCIL', 'ON_BUSINESS_TRIP', 'DO_NOT_DISTURB', 'OFFLINE']),
    until: z.string().datetime().nullable().optional(),
  })
  .strict();

export const quietHoursInput = z
  .object({
    enabled: z.boolean(),
    timezone: z.string().min(1).max(64),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(0).max(1439),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7),
    digestEnabled: z.boolean(),
  })
  .strict();
