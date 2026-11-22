/**
 * White-label settings (tenants.theme_overrides) may only override the brand
 * palette, and only with plain hex colors. Anything else is ignored, so an
 * admin setting can never inject CSS.
 */
export const OVERRIDABLE = [
  '--puet-navy-primary',
  '--puet-navy-accent',
  '--puet-terracotta-accent',
  '--puet-terracotta-deep',
  '--puet-ice-surface',
  '--puet-ice-shadow',
] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

export function sanitizeOverrides(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const name = k.startsWith('--') ? k : `--${k}`;
    if ((OVERRIDABLE as readonly string[]).includes(name) && typeof v === 'string' && HEX.test(v)) out[name] = v;
  }
  return out;
}

export function applyOverrides(raw: unknown, root: HTMLElement = document.documentElement) {
  for (const name of OVERRIDABLE) root.style.removeProperty(name);
  for (const [k, v] of Object.entries(sanitizeOverrides(raw))) root.style.setProperty(k, v);
}
