import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { PDFDocument, PDFFont, PDFPage, RGB } from 'pdf-lib';
import { degrees } from 'pdf-lib';

/**
 * Inter (brand body font, SIL OFL) from @fontsource/inter. The package ships one
 * file per Unicode subset, so text is split into runs, each drawn with the
 * first subset that has every glyph of the run.
 */
const SUBSETS = ['latin', 'cyrillic', 'latin-ext', 'cyrillic-ext'] as const;
type Weight = 400 | 600;

const cache = new Map<string, { bytes: Buffer; font: fontkit.Font }>();

function load(subset: string, weight: Weight) {
  const key = `${subset}-${weight}`;
  let entry = cache.get(key);
  if (!entry) {
    const require = createRequire(__filename);
    const dir = join(dirname(require.resolve('@fontsource/inter/package.json')), 'files');
    const bytes = readFileSync(join(dir, `inter-${subset}-${weight}-normal.woff`));
    entry = { bytes, font: fontkit.create(bytes) as fontkit.Font };
    cache.set(key, entry);
  }
  return entry;
}

export class TextWriter {
  private readonly embedded = new Map<string, PDFFont>();

  private constructor(private readonly doc: PDFDocument) {}

  static attach(doc: PDFDocument): TextWriter {
    doc.registerFontkit(fontkit);
    return new TextWriter(doc);
  }

  private async font(subset: string, weight: Weight) {
    const key = `${subset}-${weight}`;
    let f = this.embedded.get(key);
    if (!f) {
      f = await this.doc.embedFont(load(subset, weight).bytes, { subset: true });
      this.embedded.set(key, f);
    }
    return f;
  }

  /** Splits text into runs that one subset can render. Unknown characters become "?". */
  private async runs(text: string, weight: Weight) {
    const out: { text: string; font: PDFFont }[] = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      let subset = SUBSETS.find((s) => load(s, weight).font.hasGlyphForCodePoint(cp));
      let glyph = ch;
      if (!subset) {
        subset = 'latin';
        glyph = '?';
      }
      const font = await this.font(subset, weight);
      const last = out.at(-1);
      if (last && last.font === font) last.text += glyph;
      else out.push({ text: glyph, font });
    }
    return out;
  }

  async width(text: string, size: number, weight: Weight = 400) {
    let w = 0;
    for (const r of await this.runs(text, weight)) w += r.font.widthOfTextAtSize(r.text, size);
    return w;
  }

  async draw(
    page: PDFPage,
    text: string,
    opts: { x: number; y: number; size: number; color: RGB; opacity?: number; rotate?: number; weight?: Weight },
  ) {
    const angle = ((opts.rotate ?? 0) * Math.PI) / 180;
    let { x, y } = opts;
    for (const r of await this.runs(text, opts.weight ?? 400)) {
      page.drawText(r.text, {
        x,
        y,
        size: opts.size,
        font: r.font,
        color: opts.color,
        opacity: opts.opacity ?? 1,
        rotate: degrees(opts.rotate ?? 0),
      });
      const w = r.font.widthOfTextAtSize(r.text, opts.size);
      x += w * Math.cos(angle);
      y += w * Math.sin(angle);
    }
  }
}
