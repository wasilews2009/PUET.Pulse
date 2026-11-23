import { z } from 'zod';

const MAX_BATCH = 500;
const code = z.string().trim().min(1).max(64);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const text = (max: number) => z.string().trim().min(1).max(max);

// ───────────── People ─────────────

export const orderDocumentInput = z
  .object({
    type: z.enum(['STUDY_CERTIFICATE', 'MILITARY_CERTIFICATE', 'INCOME_CERTIFICATE', 'ACADEMIC_TRANSCRIPT']),
    copies: z.number().int().min(1).max(5).default(1),
    purpose: text(200).optional(),
  })
  .strict();

export const createTicketInput = z
  .object({
    category: z.enum(['IT', 'FACILITIES', 'DORMITORY']),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
    title: z.string().trim().min(3).max(120),
    description: text(4000),
    location: text(120).optional(),
  })
  .strict()
  .refine((t) => t.category === 'DORMITORY' || t.location !== undefined, { message: 'Say where the problem is', path: ['location'] });

export const ticketCommentInput = z.object({ comment: text(2000) }).strict();

/** Requester: confirm a resolved ticket or reopen it. */
export const ticketRequesterInput = z
  .object({ action: z.enum(['CONFIRM', 'REOPEN']), comment: text(2000).optional() })
  .strict()
  .refine((t) => t.action !== 'REOPEN' || t.comment !== undefined, { message: 'Say what is still wrong', path: ['comment'] });

/** Handler: move a ticket along, or forward a dormitory repair to the facilities service. */
export const ticketHandleInput = z
  .object({
    status: z.enum(['IN_PROGRESS', 'RESOLVED', 'REJECTED']).optional(),
    forwardTo: z.literal('FACILITIES').optional(),
    assignToMe: z.boolean().optional(),
    comment: text(2000).optional(),
  })
  .strict()
  .refine((t) => t.status !== undefined || t.forwardTo !== undefined || t.assignToMe === true, { message: 'Nothing to change' })
  .refine((t) => t.status !== 'REJECTED' || t.comment !== undefined, { message: 'A rejection needs a comment', path: ['comment'] });

export const askInput = z.object({ question: z.string().trim().min(3).max(500) }).strict();

export const admissionsUploadInput = z
  .object({
    title: z.string().trim().min(3).max(200),
    /** Plain text or Markdown of the admission rules (headings start with #). */
    text: z.string().min(100).max(1_000_000),
    activate: z.boolean().default(true),
  })
  .strict();

// ───────────── Webhooks ─────────────

/** Deanery / ЄДЕБО office: certificate progress and individual study plans (ІНП). */
export const deaneryBatch = z
  .object({
    documents: z
      .array(
        z.object({
          requestId: z.string().uuid(),
          status: z.enum(['IN_PROGRESS', 'READY', 'ISSUED', 'REJECTED']),
          note: text(500).optional(),
          externalRef: code.optional(),
        }),
      )
      .max(MAX_BATCH)
      .default([]),
    studyPlans: z
      .array(
        z.object({
          edeboId: code,
          semesterCode: code,
          status: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'NEEDS_CHANGES']),
          credits: z.number().min(0).max(200).optional(),
          note: text(500).optional(),
        }),
      )
      .max(MAX_BATCH)
      .default([]),
  })
  .refine((b) => b.documents.length + b.studyPlans.length > 0, 'empty batch');
export type DeaneryBatch = z.infer<typeof deaneryBatch>;

/** «Розклад ПУЕТ»: changes to classes of a course offering or of a whole group. */
export const scheduleBatch = z.object({
  changes: z
    .array(
      z
        .object({
          externalId: code,
          courseExternalId: code.optional(),
          groupCode: code.optional(),
          date: isoDate,
          pair: z.number().int().min(1).max(10),
          kind: z.enum(['ROOM_CHANGE', 'CANCELLED', 'MOVED', 'ONLINE']),
          room: text(64).optional(),
          newDate: isoDate.optional(),
          newPair: z.number().int().min(1).max(10).optional(),
          link: z.string().url().max(500).optional(),
          note: text(300).optional(),
        })
        .refine((c) => c.courseExternalId !== undefined || c.groupCode !== undefined, 'courseExternalId or groupCode')
        .refine((c) => c.kind !== 'MOVED' || c.newDate !== undefined, 'a moved class needs newDate')
        .refine((c) => c.kind !== 'ROOM_CHANGE' || c.room !== undefined, 'a room change needs room'),
    )
    .min(1)
    .max(MAX_BATCH),
});
export type ScheduleBatch = z.infer<typeof scheduleBatch>;

/** ЕДО / Канцелярія: registration numbers of approved orders. */
export const edoBatch = z.object({
  registrations: z
    .array(z.object({ routeId: z.string().uuid(), registrationNo: code, registeredAt: z.string().datetime() }))
    .min(1)
    .max(MAX_BATCH),
});
export type EdoBatch = z.infer<typeof edoBatch>;
