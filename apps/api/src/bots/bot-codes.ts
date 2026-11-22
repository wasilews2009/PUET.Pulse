import { BotCode } from '@puet/shared';

/** URL slugs of the corporate bots. Routes take a slug, never a free-form id. */
export const BOT_SLUGS: Readonly<Record<string, BotCode>> = {
  deanery: BotCode.DEANERY,
  schedule: BotCode.SCHEDULE,
  'service-desk': BotCode.SERVICE_DESK,
  chancellery: BotCode.CHANCELLERY,
  admissions: BotCode.ADMISSIONS,
};

export const BOT_SLUG_RE = /^(deanery|schedule|service-desk|chancellery|admissions)$/;

export const slugOf = (code: BotCode): string => Object.entries(BOT_SLUGS).find(([, c]) => c === code)![0];

/** The org unit (by seed code) whose staff run each bot's office. */
export const BOT_OFFICE: Readonly<Record<BotCode, string>> = {
  DEANERY: 'STUDENT_DOCS',
  SCHEDULE: 'EDEBO_AUTOMATION',
  SERVICE_DESK: 'IT_CENTER',
  CHANCELLERY: 'CHANCELLERY',
  ADMISSIONS: 'ADMISSIONS',
};

/** Service desk routing: unit codes per ticket category (dormitory repairs go to the commandant). */
export const TICKET_UNIT = { IT: 'IT_CENTER', FACILITIES: 'AHR' } as const;
