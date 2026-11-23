import { z } from 'zod';

/** Slots are published at most this far ahead. */
const MAX_AHEAD_MS = 180 * 86_400_000;

export const createSlotsInput = z
  .object({
    startsAt: z
      .string()
      .datetime()
      .refine((v) => {
        const t = new Date(v).getTime();
        return t > Date.now() && t <= Date.now() + MAX_AHEAD_MS;
      }, 'must be in the future and within 180 days'),
    durationMinutes: z.number().int().min(10).max(240),
    capacity: z.number().int().min(1).max(50).default(1),
    mode: z.enum(['ONLINE', 'OFFLINE']),
    /** Auditorium or office, for in-person consultations only. */
    location: z.string().trim().min(1).max(120).optional(),
    /** Optional: only students of this course offering may book. */
    courseOfferingId: z.string().uuid().optional(),
    note: z.string().trim().min(1).max(300).optional(),
    /** The same time every week, this many weeks (1 = once). */
    repeatWeeks: z.number().int().min(1).max(20).default(1),
  })
  .strict()
  .refine((s) => (s.mode === 'OFFLINE') === (s.location !== undefined), {
    message: 'a location is required in person and not allowed online',
    path: ['location'],
  });
export type CreateSlotsInput = z.infer<typeof createSlotsInput>;

export const bookInput = z
  .object({
    /** What the student wants to discuss. Visible to the host only. */
    topic: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type BookInput = z.infer<typeof bookInput>;
