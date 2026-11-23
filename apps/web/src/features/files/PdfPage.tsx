import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Annotation, AnnotationColor, Rect } from '../../api/types';
import type { PdfDoc } from './pdf';

export const ANNOTATION_COLORS: Record<AnnotationColor, string> = {
  yellow: 'rgba(250, 204, 21, 0.35)',
  green: 'rgba(31, 122, 77, 0.30)',
  blue: 'rgba(42, 106, 146, 0.30)',
  red: 'rgba(179, 38, 30, 0.30)',
  navy: 'rgba(22, 60, 86, 0.30)',
  terracotta: 'rgba(223, 72, 39, 0.30)',
};

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/**
 * One PDF page drawn to a canvas (no text layer: nothing to select or copy),
 * with the JSON annotation layer on top. Coordinates are relative (0..1), as
 * stored by the API, so annotations survive zoom and different screens.
 */
export function PdfPage({
  doc,
  pageNumber,
  scale,
  annotations,
  drawing,
  onDraw,
  activeId,
  onSelect,
  label,
  marks = [],
}: {
  doc: PdfDoc;
  pageNumber: number;
  scale: number;
  annotations: Annotation[];
  drawing: boolean;
  onDraw: (r: Rect) => void;
  activeId: string | null;
  onSelect: (id: string) => void;
  label: string;
  /** Search matches on this page, outlined in terracotta. */
  marks?: Rect[];
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    void doc.getPage(pageNumber).then((page) => {
      if (cancelled || !canvas.current) return;
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale });
      const c = canvas.current;
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      c.style.width = `${Math.floor(vp.width)}px`;
      c.style.height = `${Math.floor(vp.height)}px`;
      setSize({ w: Math.floor(vp.width), h: Math.floor(vp.height) });
      const ctx = c.getContext('2d');
      if (!ctx) return;
      task = page.render({ canvas: c, canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined, annotationMode: 0 });
      task.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, scale]);

  const rel = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };

  return (
    <div className="relative mx-auto bg-white shadow-2xl" style={size ? { width: size.w, height: size.h } : undefined}>
      <canvas ref={canvas} role="img" aria-label={label} onContextMenu={(e) => e.preventDefault()} />
      {size && (
        <svg
          className={drawing ? 'absolute inset-0 cursor-crosshair touch-none' : 'absolute inset-0'}
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          width={size.w}
          height={size.h}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            if (!drawing) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const p = rel(e);
            setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
          }}
          onPointerMove={(e) => {
            if (!drawing || !draft) return;
            const p = rel(e);
            setDraft({ ...draft, x1: p.x, y1: p.y });
          }}
          onPointerUp={() => {
            if (!draft) return;
            const r = { x: Math.min(draft.x0, draft.x1), y: Math.min(draft.y0, draft.y1), w: Math.abs(draft.x1 - draft.x0), h: Math.abs(draft.y1 - draft.y0) };
            setDraft(null);
            if (r.w > 0.005 && r.h > 0.003) onDraw(r);
          }}
        >
          {annotations.flatMap((a) =>
            a.rects.map((r, i) => (
              <rect
                key={`${a.id}-${i}`}
                x={r.x}
                y={r.y}
                width={r.w}
                height={r.h}
                fill={a.kind === 'highlight' || a.kind === 'comment' || a.kind === 'note' ? ANNOTATION_COLORS[a.color] : 'transparent'}
                stroke={a.id === activeId ? '#DF4827' : a.kind === 'underline' || a.kind === 'strike' ? '#163C56' : 'none'}
                strokeWidth={a.id === activeId ? 0.003 : 0.002}
                vectorEffect="non-scaling-stroke"
                className="cursor-pointer"
                onClick={() => !drawing && onSelect(a.id)}
              />
            )),
          )}
          {marks.map((r, i) => (
            <rect
              key={`m-${i}`}
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              fill="rgba(223, 72, 39, 0.18)"
              stroke="#DF4827"
              strokeWidth={0.0015}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          ))}
          {draft && (
            <rect
              x={Math.min(draft.x0, draft.x1)}
              y={Math.min(draft.y0, draft.y1)}
              width={Math.abs(draft.x1 - draft.x0)}
              height={Math.abs(draft.y1 - draft.y0)}
              fill={ANNOTATION_COLORS.yellow}
              stroke="#DF4827"
              strokeWidth={0.002}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      )}
    </div>
  );
}
