import { CalendarBlank, ChatCircleText, GraduationCap, Stamp, Wrench } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { ApiError } from '../../api/client';
import type { BotSlug } from '../../api/types';

export const BOT_ORDER: BotSlug[] = ['deanery', 'schedule', 'service-desk', 'chancellery', 'admissions'];
export const isBotSlug = (s: string | undefined): s is BotSlug => !!s && (BOT_ORDER as string[]).includes(s);

export function BotIcon({ bot, size = 22 }: { bot: BotSlug; size?: number }): ReactNode {
  const p = { size, 'aria-hidden': true } as const;
  switch (bot) {
    case 'deanery':
      return <GraduationCap {...p} />;
    case 'schedule':
      return <CalendarBlank {...p} />;
    case 'service-desk':
      return <Wrench {...p} />;
    case 'chancellery':
      return <Stamp {...p} />;
    case 'admissions':
      return <ChatCircleText {...p} />;
  }
}

/** Calendar date (YYYY-MM-DD) in the reader's language, without shifting the day by time zone. */
export function formatDay(day: string, lang: string) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString(lang === 'en' ? 'en-GB' : 'uk-UA', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : 0);
