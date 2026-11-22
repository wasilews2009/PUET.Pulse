/**
 * Content filter for minors (Ліцей ПУЕТ and anyone under 18), Phase 9.
 *
 * Pure and dependency-free so the API (plaintext channels) and the web client
 * (end-to-end encrypted chats, where only the minor's own device can see the
 * text) apply the same rules. It is a word and link filter, not a classifier:
 * it blocks obscene vocabulary in Ukrainian, Russian and English, written with
 * Latin look-alike letters, separators or repeated letters, and links to hosts
 * outside an allowlist.
 */

export type ContentFlag = 'PROFANITY' | 'EXTERNAL_LINK';

export interface ContentFilterOptions {
  /** Hosts (and their subdomains) that links may point to. */
  allowedLinkHosts?: readonly string[];
  /** Skip the link rule (e.g. staff posting study materials). */
  allowLinks?: boolean;
}

/** University hosts that are always allowed. */
export const MINOR_SAFE_HOSTS: readonly string[] = ['puet.edu.ua'];

/** Latin letters that look like Cyrillic ones, used to dodge filters ("xyй", "cyka"). */
const LOOKALIKES: Record<string, string> = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'і', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у',
  '0': 'о', '3': 'з', '@': 'а', '6': 'б',
};

const LETTER = 'a-zа-яґєії';

/** Lower case, unify letter variants, join letters split by separators, squeeze repeats. */
export function normalizeForFilter(text: string): string {
  const L = `[${LETTER}0-9@]`;
  let s = text.normalize('NFKC').toLowerCase().replace(/ё/g, 'е');
  // "х у й", "х.у.й": a run of three or more single letters separated by spaces or dots.
  s = s.replace(new RegExp(`(?<![${LETTER}])(?:${L}[\\s.]+){2,}${L}(?![${LETTER}])`, 'g'), (run) => run.replace(/[\s.]+/g, ''));
  // "х*й", "ху_й", "x-y-й": symbols inside a word.
  s = s.replace(new RegExp(`(?<=${L})[*._\\-'’]+(?=${L})`, 'g'), '');
  // Look-alike Latin letters and digits, inside words that mix them with Cyrillic or look Cyrillic as a whole.
  s = s.replace(new RegExp(`${L}+`, 'g'), (w) =>
    /[а-яґєії]/.test(w) || /^[aceopxyhkmtib0-9@]+$/.test(w) ? [...w].map((ch) => LOOKALIKES[ch] ?? ch).join('') : w,
  );
  s = s.replace(/є/g, 'е').replace(/ї/g, 'і').replace(/ы/g, 'и');
  // "хууууй" → "хуй".
  return s.replace(new RegExp(`([${LETTER}])\\1{2,}`, 'g'), '$1');
}

const B = `(?:^|[^${LETTER}])`;
const E = `(?=[^${LETTER}]|$)`;
const PREFIX = '(?:на|по|за|от|у|о|до|ви|вы|роз|раз|под|під|об|из|із|при|про|недо|пере|а)?';

/** Obscene stems. Each pattern is anchored at a word start so ordinary words containing the letters pass. */
const PROFANITY: readonly RegExp[] = [
  new RegExp(`${B}${PREFIX}ху[йяеиюі]`),
  new RegExp(`п[иі]зд`),
  new RegExp(`${B}${PREFIX}[её]б(?:а|у|и|л|ан|ал|ну|уч|ош|ёт|ет)`),
  new RegExp(`${B}бля(?:д|ть?)?${E}|${B}бляд`),
  new RegExp(`${B}${PREFIX}йоб`),
  new RegExp(`${B}сук(?:а|и|у|ою|ам|ами)${E}`),
  new RegExp(`${B}муд[ао]к|${B}муд[ие]л`),
  new RegExp(`${B}п[иіе]д[оа]р(?:а|и|ас|ов|ів)?${E}|${B}п[иі]дер(?:ас|аст)?${E}`),
  new RegExp(`${B}залуп`),
  new RegExp(`${B}г[аоіи]вн[оюаяі]`),
  new RegExp(`${B}шлюх`),
  new RegExp(`${B}${PREFIX}дроч`),
  // English (checked on the lower-cased text before look-alike mapping).
  /(?:^|[^a-z])(?:mother)?f+u+c+k|(?:^|[^a-z])sh[i1]t(?:s|ty|head)?(?:[^a-z]|$)|(?:^|[^a-z])c+u+n+t|(?:^|[^a-z])b[i1]tch|(?:^|[^a-z])a+s+h+o+l+e|(?:^|[^a-z])wh[o0]re/,
];

/** Masked spellings ("х*й", "п*зда", "б**ть"), checked on the text before separators are removed. */
const MASKED = new RegExp(`${B}(?:на|по|до|за)?х[*#]+[йяеуюі]|${B}п[*#]+зд|${B}б[*#]+(?:я|ть)|${B}с[*#]+к[аи]${E}`);

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

function hostOf(url: string): string | null {
  const m = /^(?:https?:\/\/)?([^/\s:?#]+)/i.exec(url.startsWith('www.') ? `http://${url}` : url);
  return m ? m[1]!.toLowerCase().replace(/\.$/, '') : null;
}

const hostAllowed = (host: string, allowed: readonly string[]) => allowed.some((h) => host === h || host.endsWith(`.${h}`));

/** Reasons a text may not reach (or come from) a minor. Empty means the text passes. */
export function minorContentFlags(text: string, opts: ContentFilterOptions = {}): ContentFlag[] {
  const flags: ContentFlag[] = [];
  const lower = text.normalize('NFKC').toLowerCase();
  const norm = normalizeForFilter(text);
  if (MASKED.test(lower) || PROFANITY.some((re) => re.test(norm) || re.test(lower))) flags.push('PROFANITY');
  if (!opts.allowLinks) {
    const allowed = [...MINOR_SAFE_HOSTS, ...(opts.allowedLinkHosts ?? [])].map((h) => h.toLowerCase());
    for (const m of text.matchAll(URL_RE)) {
      const host = hostOf(m[0]);
      if (!host || !hostAllowed(host, allowed)) {
        flags.push('EXTERNAL_LINK');
        break;
      }
    }
  }
  return flags;
}
