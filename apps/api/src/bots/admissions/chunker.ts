/**
 * Splits the admission rules into retrievable chunks. Headings (`#`, `##`, ... or numbered
 * section titles such as «3. Прийом документів») start a new section; paragraphs are packed into
 * chunks of at most MAX_CHUNK characters under the current heading. Long paragraphs are cut on
 * sentence boundaries, and only as a last resort mid-sentence.
 */
export const MAX_CHUNK = 1200;
const MAX_HEADING = 200;

export interface Chunk {
  ordinal: number;
  heading: string | null;
  text: string;
}

const MD_HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
// «1. Загальні положення», «IV. Строки прийому», «Розділ 2. ...» on their own short line.
const NUMBERED_HEADING = /^(?:(?:розділ|section)\s+)?(?:\d{1,2}|[IVXLC]{1,6})\.\s+\S.{0,120}$/iu;

const normalize = (s: string) => s.replace(/[ \t ]+/g, ' ').trim();

function splitLong(paragraph: string): string[] {
  if (paragraph.length <= MAX_CHUNK) return [paragraph];
  const sentences = paragraph.match(/[^.!?…]+(?:[.!?…]+|$)\s*/gu) ?? [paragraph];
  const out: string[] = [];
  let cur = '';
  for (const raw of sentences) {
    let s = raw.trim();
    while (s.length > MAX_CHUNK) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      out.push(s.slice(0, MAX_CHUNK));
      s = s.slice(MAX_CHUNK).trim();
    }
    if (!s) continue;
    if (cur && cur.length + 1 + s.length > MAX_CHUNK) {
      out.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function chunkRules(source: string): Chunk[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const chunks: Chunk[] = [];
  let heading: string | null = null;
  let paragraphs: string[] = [];
  let para: string[] = [];

  const flushPara = () => {
    const p = normalize(para.join(' '));
    para = [];
    if (p) paragraphs.push(p);
  };
  const flushSection = () => {
    flushPara();
    let cur = '';
    for (const p of paragraphs.flatMap(splitLong)) {
      if (cur && cur.length + 2 + p.length > MAX_CHUNK) {
        chunks.push({ ordinal: chunks.length, heading, text: cur });
        cur = p;
      } else {
        cur = cur ? `${cur}\n\n${p}` : p;
      }
    }
    if (cur) chunks.push({ ordinal: chunks.length, heading, text: cur });
    paragraphs = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const md = MD_HEADING.exec(trimmed);
    const isHeading = md !== null || (para.length === 0 && NUMBERED_HEADING.test(trimmed) && !/[.:;]$/.test(trimmed.replace(/^\S+\s/, '')));
    if (isHeading) {
      flushSection();
      heading = normalize(md ? md[1]! : trimmed).slice(0, MAX_HEADING) || null;
    } else if (!trimmed) {
      flushPara();
    } else {
      para.push(trimmed);
    }
  }
  flushSection();
  return chunks;
}

/**
 * Turns a free-form question into a prefix tsquery over letters and digits only, so no tsquery
 * operator from the user ever reaches PostgreSQL. Ukrainian words are inflected, so longer words
 * drop their last two letters before the prefix match («вступу» → «всту:*»).
 */
export function toPrefixQuery(question: string, maxTerms = 12): string | null {
  const seen = new Set<string>();
  for (const m of question.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    if (w.length < 3 && !/^\p{N}+$/u.test(w)) continue;
    if (STOP.has(w)) continue;
    seen.add(w.length > 5 ? w.slice(0, -2) : w);
    if (seen.size >= maxTerms) break;
  }
  if (seen.size === 0) return null;
  return [...seen].map((t) => `${t}:*`).join(' | ');
}

const STOP = new Set([
  'або', 'але', 'для', 'що', 'чи', 'як', 'які', 'яка', 'який', 'яке', 'коли', 'про', 'при', 'від', 'без', 'над', 'під',
  'мені', 'мене', 'можна', 'треба', 'потрібно', 'потрібні', 'потрібна', 'потрібен', 'чому', 'скільки', 'будь', 'ласка', 'where', 'what', 'when', 'how', 'the', 'and', 'for',
  'can', 'does', 'is', 'are', 'which', 'who', 'with', 'это', 'что', 'как',
]);
