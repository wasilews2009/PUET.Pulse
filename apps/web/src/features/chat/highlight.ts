import { common, createLowlight } from 'lowlight';

const lowlight = createLowlight(common);

export type HastNode = { type: string; value?: string; tagName?: string; properties?: { className?: string[] }; children?: HastNode[] };

/** Syntax tree for a known language, or null (then the block stays plain text). */
export function highlight(lang: string, text: string): HastNode | null {
  if (!lowlight.registered(lang)) return null;
  return lowlight.highlight(lang, text) as unknown as HastNode;
}
