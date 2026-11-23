import { createElement, Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { hasFormatting, parseMessage } from './format';
import type { HastNode } from './highlight';

/** lowlight returns a tree of <span class="hljs-…"> and text: rebuilt as React elements, never as HTML. */
function toReact(node: HastNode, key: number): ReactNode {
  if (node.type === 'text') return node.value ?? '';
  const children = (node.children ?? []).map((c, i) => toReact(c, i));
  if (node.type === 'element') {
    const cls = (node.properties?.className ?? []).filter((c) => /^hljs-[a-z_-]+$/.test(c)).join(' ');
    return createElement('span', { key, className: cls || undefined }, children);
  }
  return createElement(Fragment, { key }, children);
}

function CodeBlock({ lang, text }: { lang: string | null; text: string }) {
  const [tree, setTree] = useState<HastNode | null>(null);
  useEffect(() => {
    let live = true;
    setTree(null);
    if (!lang || text.length > 20_000) return;
    // The highlighter is loaded only when a message has a code block.
    void import('./highlight').then(({ highlight }) => {
      if (live) setTree(highlight(lang, text));
    });
    return () => {
      live = false;
    };
  }, [lang, text]);
  return (
    <pre className="pulse-code my-1 max-h-96 overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-xs leading-5 whitespace-pre text-code-ink">
      {lang && <span className="mb-1 block caption-5 opacity-60">{lang}</span>}
      <code>{tree ? toReact(tree, 0) : text}</code>
    </pre>
  );
}

function Formula({ tex, display }: { tex: string; display: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let live = true;
    void import('./math').then(({ renderMath }) => {
      if (live && ref.current) renderMath(ref.current, tex, display);
    });
    return () => {
      live = false;
    };
  }, [tex, display]);
  // The source stays as text until KaTeX has loaded, so nothing is lost without it.
  return (
    <span ref={ref} className={display ? 'my-1 block overflow-x-auto whitespace-normal' : 'whitespace-normal'}>
      {display ? `$$${tex}$$` : `\\(${tex}\\)`}
    </span>
  );
}

/** Plain text, or text with code and formulas. Always rendered as text nodes and elements. */
export function MessageBody({ text }: { text: string }) {
  const segments = useMemo(() => (hasFormatting(text) ? parseMessage(text) : null), [text]);
  if (!segments) return <p className="break-words whitespace-pre-wrap">{text}</p>;
  return (
    <div className="break-words whitespace-pre-wrap">
      {segments.map((s, i) =>
        s.kind === 'text' ? (
          <Fragment key={i}>{s.text}</Fragment>
        ) : s.kind === 'code' ? (
          <code key={i} className="rounded bg-code px-1 py-0.5 font-mono text-xs text-code-ink">
            {s.text}
          </code>
        ) : s.kind === 'block' ? (
          <CodeBlock key={i} lang={s.lang} text={s.text} />
        ) : (
          <Formula key={i} tex={s.tex} display={s.display} />
        ),
      )}
    </div>
  );
}
