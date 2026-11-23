/**
 * Unit tests of the Phase 8 building blocks that need no database: the admission rules chunker,
 * the tsquery builder, the schedule link allowlist and the Claude answer adapter.
 */
import { describe, expect, it } from 'vitest';
import { ClaudeAnswerGenerator, ExtractiveAnswerGenerator, type Excerpt } from '../src/bots/admissions/answer-generator';
import { MAX_CHUNK, chunkRules, toPrefixQuery } from '../src/bots/admissions/chunker';
import { MemoryRateLimiter } from '../src/bots/admissions/rate-limiter';
import { allowedLink } from '../src/bots/schedule.service';

const RULES = `# Правила прийому до ПУЕТ 2027

## 1. Загальні положення
Ці Правила визначають порядок вступу.

## 2. Строки прийому заяв
Прийом заяв і документів триває з 1 по 31 липня.
Вступники подають заяви в електронній формі.

## 3. Перелік документів
${'Вступник подає документ про освіту, паспорт і сертифікат НМТ. '.repeat(60)}
`;

describe('admissions chunker', () => {
  it('keeps section titles and stays under the chunk size', () => {
    const chunks = chunkRules(RULES);
    expect(chunks.map((c) => c.heading)).toContain('2. Строки прийому заяв');
    expect(chunks.every((c) => c.text.length <= MAX_CHUNK)).toBe(true);
    expect(chunks.filter((c) => c.heading === '3. Перелік документів').length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it('treats a short numbered line as a heading, but not a numbered sentence', () => {
    const chunks = chunkRules('1. Загальні положення\nТекст розділу.\n\n2. Вступник подає заяву до 31 липня.\n');
    expect(chunks[0]!.heading).toBe('1. Загальні положення');
    expect(chunks).toHaveLength(1);
  });
});

describe('admissions query builder', () => {
  it('tsquery injection: operators and quotes never reach PostgreSQL', () => {
    const q = toPrefixQuery("документи' & !(вступ) | :* <-> ') ; DROP TABLE users; --")!;
    expect(q).toMatch(/^[\p{L}\p{N}]+:\*( \| [\p{L}\p{N}]+:\*)*$/u);
    expect(q).not.toMatch(/[&!()<>';-]/);
  });

  it('drops stop words, short words and stems long Ukrainian words', () => {
    expect(toPrefixQuery('Які документи потрібні для вступу?')).toBe('докумен:* | всту:*');
    expect(toPrefixQuery('? ! що')).toBeNull();
    expect(toPrefixQuery('НМТ 2027')).toBe('нмт:* | 2027:*');
  });
});

describe('schedule links', () => {
  const hosts = ['moodle.puet.edu.ua', 'zoom.us'];
  it('phishing: only https links to allowlisted hosts pass', () => {
    expect(allowedLink('https://moodle.puet.edu.ua/course/view.php?id=7', hosts)).toBe('https://moodle.puet.edu.ua/course/view.php?id=7');
    expect(allowedLink('https://us02web.zoom.us/j/123', hosts)).not.toBeNull();
    expect(allowedLink('http://zoom.us/j/1', hosts)).toBeNull();
    expect(allowedLink('https://zoom.us.evil.example/j/1', hosts)).toBeNull();
    expect(allowedLink('https://evilzoom.us/j/1', hosts)).toBeNull();
    expect(allowedLink('https://user:pw@zoom.us/j/1', hosts)).toBeNull();
    expect(allowedLink('https://zoom.us:8443/j/1', hosts)).toBeNull();
    expect(allowedLink('javascript:alert(1)', hosts)).toBeNull();
  });
});

describe('admissions answers', () => {
  const excerpts: Excerpt[] = [
    { n: 1, heading: '2. Строки прийому заяв', text: 'Прийом заяв триває з 1 по 31 липня.' },
    { n: 2, heading: null, text: 'Вступники подають заяви в електронній формі.' },
  ];

  it('extractive: quotes the rules with their numbers, says so when nothing matches', async () => {
    const g = new ExtractiveAnswerGenerator();
    const a = await g.answer('строки', excerpts, 'uk');
    expect(a.mode).toBe('extractive');
    expect(a.body).toContain('[1] 2. Строки прийому заяв');
    expect(a.used).toEqual([1, 2]);
    expect((await g.answer('x', [], 'en')).mode).toBe('none');
  });

  const fake = (res: unknown, sink: unknown[] = []) =>
    ({
      beta: {
        messages: {
          create: async (params: unknown) => {
            sink.push(params);
            if (res instanceof Error) throw res;
            return res;
          },
        },
      },
    }) as never;

  it('Claude: sends only the question and excerpts, with server-side fallback, and keeps cited answers', async () => {
    const sent: { model: string; fallbacks: string; betas: string[]; messages: { content: string }[]; system: string }[] = [];
    const g = new ClaudeAnswerGenerator(fake({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Заяви приймають з 1 по 31 липня [1].' }] }, sent), 'claude-opus-5-5');
    const a = await g.answer('Коли подавати заяву?', excerpts, 'uk');
    expect(a).toEqual({ mode: 'llm', body: 'Заяви приймають з 1 по 31 липня [1].', used: [1] });
    expect(sent[0]!.model).toBe('claude-opus-5-5');
    expect(sent[0]!.fallbacks).toBe('default');
    expect(sent[0]!.betas).toContain('server-side-fallback-2026-07-01');
    expect(sent[0]!.messages[0]!.content).toContain('<question>Коли подавати заяву?</question>');
  });

  it('Claude: a refusal, an error or an uncited answer falls back to quoting the rules', async () => {
    for (const res of [
      { stop_reason: 'refusal', content: [] },
      new Error('network'),
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Подавайте коли завгодно.' }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Див. [7].' }] },
    ]) {
      const a = await new ClaudeAnswerGenerator(fake(res), 'claude-opus-5-5').answer('Коли?', excerpts, 'uk');
      expect(a.mode).toBe('extractive');
    }
  });
});

describe('rate limiter', () => {
  it('allows `limit` hits per window', async () => {
    const r = new MemoryRateLimiter();
    expect(await r.hit('k', 2, 60_000)).toBe(true);
    expect(await r.hit('k', 2, 60_000)).toBe(true);
    expect(await r.hit('k', 2, 60_000)).toBe(false);
    expect(await r.hit('other', 2, 60_000)).toBe(true);
  });
});
