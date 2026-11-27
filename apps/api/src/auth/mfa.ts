import type { RoleGrant } from '@puet/policy-engine';
import { MFA_REQUIRED_ROLES } from '@puet/shared';

/**
 * MFA is enforced by the identity provider (Keycloak OTP / WebAuthn policies);
 * the API trusts only the signed `acr` / `amr` claims of the validated ID token.
 * No TOTP secrets are stored or checked here (no custom crypto).
 */
export function idTokenProvesMfa(
  claims: { acr?: unknown; amr?: unknown },
  cfg: { mfaAcrValues: readonly string[]; mfaAmrValues: readonly string[] },
): boolean {
  if (typeof claims.acr === 'string' && cfg.mfaAcrValues.includes(claims.acr)) return true;
  if (Array.isArray(claims.amr)) {
    return claims.amr.some((m) => typeof m === 'string' && cfg.mfaAmrValues.includes(m));
  }
  return false;
}

/**
 * The authentication context of an ID token as a short, audit-safe string
 * (`acr=1 amr=pwd`), so an IdP that does not report its second factor can be
 * diagnosed from the audit log. Only claim values, never identities or tokens.
 */
export function describeAuthContext(claims: { acr?: unknown; amr?: unknown }): string {
  const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9:._-]/g, '').slice(0, 32) : '');
  const acr = clean(claims.acr) || '-';
  const amr = Array.isArray(claims.amr) ? claims.amr.slice(0, 8).map(clean).filter(Boolean).join(',') : '';
  return `acr=${acr} amr=${amr || '-'}`;
}

export function requiresMfa(grants: readonly RoleGrant[], now = new Date()): boolean {
  return grants.some(
    (g) => MFA_REQUIRED_ROLES.includes(g.role) && (!g.expiresAt || g.expiresAt.getTime() > now.getTime()),
  );
}

/** Only same-site relative paths, so the login flow cannot become an open redirect. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (/[\u0000-\u001f]/.test(value)) return '/';
  return value;
}
