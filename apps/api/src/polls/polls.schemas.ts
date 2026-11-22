import { z } from 'zod';

export const MAX_OPTIONS = 12;
/** Formal votes of collegial bodies always offer the same three answers. */
export const FORMAL_OPTIONS = ['FOR', 'AGAINST', 'ABSTAIN'] as const;
const MAX_DURATION_MS = 30 * 86_400_000;

export const createPollInput = z
  .object({
    question: z.string().trim().min(1).max(500),
    /** Ignored for formal votes (FOR / AGAINST / ABSTAIN). */
    options: z.array(z.string().trim().min(1).max(200)).min(2).max(MAX_OPTIONS).optional(),
    mode: z.enum(['OPEN', 'SECRET']),
    multipleChoice: z.boolean().default(false),
    formal: z.boolean().default(false),
    quorum: z.number().int().min(1).optional(),
    closesAt: z
      .string()
      .datetime()
      .refine((v) => {
        const t = new Date(v).getTime();
        return t > Date.now() && t <= Date.now() + MAX_DURATION_MS;
      }, 'must be in the future and within 30 days')
      .optional(),
  })
  .strict()
  .refine((p) => p.formal || p.options !== undefined, { message: 'options are required', path: ['options'] })
  .refine((p) => !p.formal || !p.multipleChoice, { message: 'a formal vote has one answer', path: ['multipleChoice'] })
  .refine((p) => p.formal || p.quorum === undefined, { message: 'quorum applies to formal votes only', path: ['quorum'] })
  .refine((p) => !p.options || new Set(p.options.map((o) => o.toLowerCase())).size === p.options.length, {
    message: 'options must be distinct',
    path: ['options'],
  });
export type CreatePollInput = z.infer<typeof createPollInput>;

export const voteInput = z
  .object({ options: z.array(z.number().int().min(0).max(MAX_OPTIONS - 1)).min(1).max(MAX_OPTIONS) })
  .strict()
  .refine((v) => new Set(v.options).size === v.options.length, { message: 'options must be distinct', path: ['options'] });
