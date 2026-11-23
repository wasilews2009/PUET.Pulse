import { createHash } from 'node:crypto';

/**
 * Tamper-evident hash chain for the audit log. Uses SHA-256 from Node's audited
 * OpenSSL binding; no custom cryptography.
 */

export interface AuditEntry {
  tenantId?: string | null;
  actorId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Deterministic JSON: object keys sorted recursively, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function computeAuditHash(prevHash: string | null, occurredAt: Date, entry: AuditEntry): string {
  const payload = canonicalJson({
    prevHash,
    occurredAt: occurredAt.toISOString(),
    tenantId: entry.tenantId ?? null,
    actorId: entry.actorId ?? null,
    action: entry.action,
    resourceType: entry.resourceType ?? null,
    resourceId: entry.resourceId ?? null,
    outcome: entry.outcome,
    reason: entry.reason ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    requestId: entry.requestId ?? null,
    metadata: entry.metadata ?? null,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export interface StoredAuditRow extends AuditEntry {
  occurredAt: Date;
  prevHash: string | null;
  hash: string;
}

/** Returns the index of the first broken row, or -1 when the chain is intact. */
export function verifyAuditChain(rows: readonly StoredAuditRow[]): number {
  let prev: string | null = rows[0]?.prevHash ?? null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.prevHash !== prev) return i;
    if (computeAuditHash(row.prevHash, row.occurredAt, row) !== row.hash) return i;
    prev = row.hash;
  }
  return -1;
}
