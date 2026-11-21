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
