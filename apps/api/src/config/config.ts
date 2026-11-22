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

/** Optional setting: an empty value in .env means "not set". */
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const integrationClient = z.object({
  /** Stable UUID used as the actor id in the audit log. */
  id: z.string().uuid(),
  /** HMAC-SHA256 shared secret, at least 32 characters. */
  secret: z.string().min(32),
  tenantCode: z.nativeEnum(TenantCode),
  kinds: z.array(z.enum(['EDEBO_STUDENTS', 'HR_STAFF', 'TEACHING_LOAD', 'OFFBOARDING', 'DEANERY', 'SCHEDULE', 'EDO'])).min(1),
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
  /** Server name used in E2EE identifiers (@<user uuid>:<name>, !<channel uuid>:<name>). */
  E2EE_SERVER_NAME: z
    .string()
    .regex(/^[a-z0-9.-]{1,253}$/)
    .default('pulse.puet.edu.ua'),
  /** Background jobs (digests, TTL purge, course archive). Disable on read-only replicas. */
  JOBS_ENABLED: z.enum(['true', 'false']).default('true'),
  // ── Phase 4: files, PDF viewer, PKI, QES ──
  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_BUCKET_ATTACHMENTS: z.string().default('puet-attachments'),
  S3_BUCKET_QUARANTINE: z.string().default('puet-quarantine'),
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  FILE_MAX_MB: z.coerce.number().int().min(1).max(500).default(50),
  /** Scan right after upload (the sweeper job retries either way). Tests turn this off to drive the pipeline. */
  FILE_SCAN_INLINE: z.enum(['true', 'false']).default('true'),
  /** Internal CA (УЕП): PEM certificate and PKCS#8 private key, outside the repository. */
  PKI_CA_CERT_FILE: optional(z.string()),
  PKI_CA_KEY_FILE: optional(z.string()),
  /** Public base URL embedded in certificates for CRL / OCSP / CA issuer and in verification QR codes. */
  PKI_PUBLIC_URL: optional(z.string().url()),
  PKI_CERT_DAYS: z.coerce.number().int().min(30).max(825).default(365),
  /** Secret for document verification codes (QR). At least 32 characters. */
  VERIFY_CODE_SECRET: optional(z.string().min(32)),
  /** On-premise QES gateway (IIT EUSignCP server) for КЕП. Unset: QES signing is unavailable. */
  QES_GATEWAY_URL: optional(z.string().url()),
  QES_GATEWAY_TOKEN: optional(z.string().min(16)),
  // ── Phase 7: WebRTC calls (LiveKit SFU, on-premise) ──
  /** Server API URL of LiveKit (http(s)://, internal network). Unset: calls are unavailable. */
  LIVEKIT_URL: optional(z.string().url()),
  /** URL browsers connect to (wss://). Default: LIVEKIT_URL with ws(s)://. */
  LIVEKIT_PUBLIC_URL: optional(z.string().url()),
  LIVEKIT_API_KEY: optional(z.string().min(3)),
  LIVEKIT_API_SECRET: optional(z.string().min(32)),
  // ── Phase 8: corporate bots ──
  /** Outbound signed webhooks to the deanery system and the ЕДО (empty URL = not sent, kept in the outbox). */
  OUTBOX_DEANERY_URL: optional(z.string().url()),
  OUTBOX_DEANERY_SECRET: optional(z.string().min(32)),
  OUTBOX_EDO_URL: optional(z.string().url()),
  OUTBOX_EDO_SECRET: optional(z.string().min(32)),
  /** Hosts allowed in schedule links (Moodle / Zoom), comma separated; subdomains included. */
  SCHEDULE_LINK_HOSTS: z.string().default('moodle.puet.edu.ua,zoom.us,meet.google.com,teams.microsoft.com'),
  /** Admissions consultant: "extractive" quotes the rules (nothing leaves the server); "anthropic" asks Claude. */
  ADMISSIONS_ANSWERS: z.enum(['extractive', 'anthropic']).default('extractive'),
  /** Only with ADMISSIONS_ANSWERS=anthropic. Never logged. */
  ANTHROPIC_API_KEY: optional(z.string().min(20)),
  ADMISSIONS_MODEL: z.string().regex(/^[a-z0-9.-]{3,64}$/).default('claude-opus-5-5'),
  /** Questions per person per hour. */
  ADMISSIONS_RATE_PER_HOUR: z.coerce.number().int().min(1).max(500).default(20),
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
  e2ee: { serverName: string };
  jobsEnabled: boolean;
  files: {
    maxBytes: number;
    scanInline: boolean;
    s3: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; buckets: { attachments: string; quarantine: string } };
    clamav: { host: string; port: number };
  };
  pki: {
    caCertFile?: string;
    caKeyFile?: string;
    publicUrl: string;
    certDays: number;
    verifyCodeSecret?: string;
    qes: { url: string; token: string } | null;
  };
  livekit: { url: string; publicUrl: string; apiKey: string; apiSecret: string } | null;
  bots: {
    outbox: Partial<Record<'DEANERY' | 'EDO', { url: string; secret: string }>>;
    scheduleLinkHosts: string[];
    admissions: { answers: 'extractive' | 'anthropic'; model: string; ratePerHour: number; apiKey?: string };
  };
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
  for (const url of [e.OUTBOX_DEANERY_URL, e.OUTBOX_EDO_URL]) {
    // Outbound events carry personal data (student ids): never over plain HTTP in production.
    if (url && e.NODE_ENV === 'production' && !url.startsWith('https://')) {
      throw new Error('Invalid configuration: OUTBOX_*_URL must use https');
    }
  }
  if (e.ADMISSIONS_ANSWERS === 'anthropic' && !e.ANTHROPIC_API_KEY) {
    throw new Error('Invalid configuration: ADMISSIONS_ANSWERS=anthropic needs ANTHROPIC_API_KEY');
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
    e2ee: { serverName: e.E2EE_SERVER_NAME },
    jobsEnabled: e.JOBS_ENABLED === 'true',
    files: {
      maxBytes: e.FILE_MAX_MB * 1024 * 1024,
      scanInline: e.FILE_SCAN_INLINE === 'true',
      s3: {
        endpoint: e.S3_ENDPOINT,
        region: e.S3_REGION,
        accessKeyId: e.S3_ACCESS_KEY_ID,
        secretAccessKey: e.S3_SECRET_ACCESS_KEY,
        buckets: { attachments: e.S3_BUCKET_ATTACHMENTS, quarantine: e.S3_BUCKET_QUARANTINE },
      },
      clamav: { host: e.CLAMAV_HOST, port: e.CLAMAV_PORT },
    },
    pki: {
      ...(e.PKI_CA_CERT_FILE ? { caCertFile: e.PKI_CA_CERT_FILE } : {}),
      ...(e.PKI_CA_KEY_FILE ? { caKeyFile: e.PKI_CA_KEY_FILE } : {}),
      publicUrl: (e.PKI_PUBLIC_URL ?? `${new URL(e.WEB_ORIGIN).origin}/api`).replace(/\/+$/, ''),
      certDays: e.PKI_CERT_DAYS,
      ...(e.VERIFY_CODE_SECRET ? { verifyCodeSecret: e.VERIFY_CODE_SECRET } : {}),
      qes: e.QES_GATEWAY_URL && e.QES_GATEWAY_TOKEN ? { url: e.QES_GATEWAY_URL, token: e.QES_GATEWAY_TOKEN } : null,
    },
    livekit:
      e.LIVEKIT_URL && e.LIVEKIT_API_KEY && e.LIVEKIT_API_SECRET
        ? {
            url: e.LIVEKIT_URL,
            publicUrl: e.LIVEKIT_PUBLIC_URL ?? e.LIVEKIT_URL.replace(/^http/, 'ws'),
            apiKey: e.LIVEKIT_API_KEY,
            apiSecret: e.LIVEKIT_API_SECRET,
          }
        : null,
    bots: {
      outbox: {
        ...(e.OUTBOX_DEANERY_URL && e.OUTBOX_DEANERY_SECRET ? { DEANERY: { url: e.OUTBOX_DEANERY_URL, secret: e.OUTBOX_DEANERY_SECRET } } : {}),
        ...(e.OUTBOX_EDO_URL && e.OUTBOX_EDO_SECRET ? { EDO: { url: e.OUTBOX_EDO_URL, secret: e.OUTBOX_EDO_SECRET } } : {}),
      },
      scheduleLinkHosts: e.SCHEDULE_LINK_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
      admissions: {
        answers: e.ADMISSIONS_ANSWERS,
        model: e.ADMISSIONS_MODEL,
        ratePerHour: e.ADMISSIONS_RATE_PER_HOUR,
        ...(e.ANTHROPIC_API_KEY ? { apiKey: e.ANTHROPIC_API_KEY } : {}),
      },
    },
  };
}
