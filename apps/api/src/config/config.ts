import { TenantCode } from '@puet/shared';
import { z } from 'zod';

export const APP_CONFIG = Symbol('APP_CONFIG');

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    );

const integrationClient = z.object({
  /** Stable UUID used as the actor id in the audit log. */
  id: z.string().uuid(),
  /** HMAC-SHA256 shared secret, at least 32 characters. */
  secret: z.string().min(32),
  tenantCode: z.nativeEnum(TenantCode),
  kinds: z.array(z.enum(['EDEBO_STUDENTS', 'HR_STAFF', 'TEACHING_LOAD', 'OFFBOARDING'])).min(1),
});
export type IntegrationClientConfig = z.infer<typeof integrationClient> & { clientId: string };

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  WEB_ORIGIN: z.string().url(),
  REDIS_URL: z.string().min(1),
  OIDC_ISSUER_URL: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  OIDC_REDIRECT_URI: z.string().url(),
  OIDC_POST_LOGOUT_REDIRECT_URI: z.string().url().optional(),
  /** acr values that prove MFA (Keycloak LoA level names / numbers). */
  OIDC_MFA_ACR_VALUES: csv('mfa,2,urn:puet:acr:mfa'),
  /** amr values that prove MFA (RFC 8176). */
  OIDC_MFA_AMR_VALUES: csv('mfa,otp,hwk,swk,totp,webauthn'),
  /** acr requested when a privileged user must step up. */
  OIDC_STEP_UP_ACR: z.string().default('mfa'),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24).default(10),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
  /** JSON object: { "<clientId>": { id, secret, tenantCode, kinds } }. */
  INTEGRATION_CLIENTS: z.string().default('{}'),
  INTEGRATION_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
});

export interface AppConfig {
  production: boolean;
  webOrigin: string;
  redisUrl: string;
  oidc: {
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    postLogoutRedirectUri?: string;
    mfaAcrValues: string[];
    mfaAmrValues: string[];
    stepUpAcr: string;
  };
  session: { absoluteMs: number; idleMs: number };
  integrations: { clients: Map<string, IntegrationClientConfig>; toleranceSeconds: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid configuration: ${fields}`);
  }
  const e = parsed.data;

  let rawClients: unknown;
  try {
    rawClients = JSON.parse(e.INTEGRATION_CLIENTS);
  } catch {
    throw new Error('Invalid configuration: INTEGRATION_CLIENTS is not valid JSON');
  }
  const clients = z.record(integrationClient).safeParse(rawClients);
  if (!clients.success) throw new Error('Invalid configuration: INTEGRATION_CLIENTS entries');

  return {
    production: e.NODE_ENV === 'production',
    webOrigin: new URL(e.WEB_ORIGIN).origin,
    redisUrl: e.REDIS_URL,
    oidc: {
      issuerUrl: e.OIDC_ISSUER_URL,
      clientId: e.OIDC_CLIENT_ID,
      clientSecret: e.OIDC_CLIENT_SECRET,
      redirectUri: e.OIDC_REDIRECT_URI,
      ...(e.OIDC_POST_LOGOUT_REDIRECT_URI ? { postLogoutRedirectUri: e.OIDC_POST_LOGOUT_REDIRECT_URI } : {}),
      mfaAcrValues: e.OIDC_MFA_ACR_VALUES,
      mfaAmrValues: e.OIDC_MFA_AMR_VALUES,
      stepUpAcr: e.OIDC_STEP_UP_ACR,
    },
    session: { absoluteMs: e.SESSION_ABSOLUTE_HOURS * 3_600_000, idleMs: e.SESSION_IDLE_MINUTES * 60_000 },
    integrations: {
      clients: new Map(Object.entries(clients.data).map(([clientId, c]) => [clientId, { ...c, clientId }])),
      toleranceSeconds: e.INTEGRATION_CLOCK_TOLERANCE_SECONDS,
    },
  };
}
