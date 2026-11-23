/**
 * Navigation and permission rules of the desktop wrapper (pure, no Electron
 * imports, unit-tested). The window shows exactly one PUET.Pulse server; the
 * web client stays the only UI and the API stays the only security boundary.
 */

export interface ShellConfig {
  /** The PUET.Pulse server, https only (e.g. https://pulse.puet.edu.ua). */
  origin: string;
  /** Hosts the sign-in may pass through (the university IdP: Keycloak / AD FS). */
  ssoHosts: string[];
}

export class ConfigError extends Error {}

/** Reads PULSE_URL and PULSE_SSO_HOSTS; refuses anything but https (http only for localhost development). */
export function parseConfig(env: Record<string, string | undefined>): ShellConfig {
  const raw = env.PULSE_URL ?? 'https://pulse.puet.edu.ua';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('PULSE_URL is not a URL');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new ConfigError('PULSE_URL must use https');
  if (url.username || url.password) throw new ConfigError('PULSE_URL must not carry credentials');
  const ssoHosts = (env.PULSE_SSO_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9.-]+$/.test(h));
  return { origin: url.origin, ssoHosts };
}

const parse = (s: string): URL | null => {
  try {
    return new URL(s);
  } catch {
    return null;
  }
};

/** What happens to a navigation or a new window. */
export type NavigationVerdict = 'allow' | 'external' | 'deny';

/**
 * In the window: the server itself, and https pages of the sign-in hosts.
 * Elsewhere: https links open in the system browser; every other scheme
 * (file:, javascript:, data:, custom protocols) is refused.
 */
export function navigationVerdict(target: string, cfg: ShellConfig): NavigationVerdict {
  const u = parse(target);
  if (!u) return 'deny';
  if (u.origin === cfg.origin) return 'allow';
  if (u.protocol === 'https:' && cfg.ssoHosts.includes(u.hostname.toLowerCase())) return 'allow';
  if (u.protocol === 'https:' && !u.username && !u.password) return 'external';
  if (u.protocol === 'mailto:') return 'external';
  return 'deny';
}

/** Electron permission names the web client needs: calls (camera, microphone, screen) and notifications. */
const ALLOWED_PERMISSIONS = new Set(['media', 'notifications', 'display-capture', 'clipboard-sanitized-write', 'fullscreen']);

export function permissionAllowed(permission: string, requestingUrl: string, cfg: ShellConfig): boolean {
  const u = parse(requestingUrl);
  return !!u && u.origin === cfg.origin && ALLOWED_PERMISSIONS.has(permission);
}

/** webPreferences for every window: no Node, isolated context, OS sandbox, no remote code paths. */
export const SECURE_WEB_PREFERENCES = {
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  spellcheck: true,
} as const;
