/**
 * Message formatting for project rooms (STEAM-HUB, Scientific Society): fenced code
 * blocks with syntax highlighting, inline code and LaTeX formulas. Parsing only:
 * nothing here produces HTML, the renderer builds React elements / DOM nodes.
 */
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'block'; lang: string | null; text: string }
  | { kind: 'math'; tex: string; display: boolean };

const TOKEN = /```([A-Za-z0-9+#-]{0,20})[ \t]*\n([\s\S]*?)\n?```|\$\$([\s\S]{1,2000}?)\$\$|\\\(([\s\S]{1,500}?)\\\)|`([^`\n]{1,500})`/g;

export function parseMessage(input: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of input.matchAll(TOKEN)) {
    const at = m.index;
    if (at > last) out.push({ kind: 'text', text: input.slice(last, at) });
    if (m[2] !== undefined) out.push({ kind: 'block', lang: m[1] ? m[1].toLowerCase() : null, text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: 'math', tex: m[3].trim(), display: true });
    else if (m[4] !== undefined) out.push({ kind: 'math', tex: m[4].trim(), display: false });
    else out.push({ kind: 'code', text: m[5]! });
    last = at + m[0].length;
  }
  if (last < input.length) out.push({ kind: 'text', text: input.slice(last) });
  return out;
}

export const hasFormatting = (input: string) => /```|\$\$|\\\(|`/.test(input);
