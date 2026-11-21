import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  computeAuditHash,
  verifyAuditChain,
  type AuditEntry,
  type StoredAuditRow,
} from '../src/audit/audit-chain';

function chain(entries: AuditEntry[]): StoredAuditRow[] {
  const rows: StoredAuditRow[] = [];
  let prev: string | null = null;
  entries.forEach((e, i) => {
    const occurredAt = new Date(Date.UTC(2026, 10, 21, 10, 0, i));
    const hash = computeAuditHash(prev, occurredAt, e);
    rows.push({ ...e, occurredAt, prevHash: prev, hash });
    prev = hash;
  });
  return rows;
}

const entries: AuditEntry[] = [
  { action: 'auth.login', outcome: 'SUCCESS', actorId: 'u1' },
  { action: 'role.assign', outcome: 'SUCCESS', actorId: 'admin', metadata: { role: 'LECTURER' } },
  { action: 'message.read', outcome: 'DENIED', actorId: 'u2', reason: 'membership.required' },
];

describe('audit hash chain', () => {
  it('canonical JSON is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('verifies an intact chain', () => {
    expect(verifyAuditChain(chain(entries))).toBe(-1);
  });

  it('detects a modified row', () => {
    const rows = chain(entries);
    rows[1] = { ...rows[1]!, metadata: { role: 'SUPER_ADMIN' } };
    expect(verifyAuditChain(rows)).toBe(1);
  });

  it('detects a deleted row', () => {
    const rows = chain(entries);
    rows.splice(1, 1);
    expect(verifyAuditChain(rows)).toBe(1);
  });

  it('detects a re-hashed forged row because the next link breaks', () => {
    const rows = chain(entries);
    const forged = { ...rows[1]!, reason: 'forged' };
    forged.hash = computeAuditHash(forged.prevHash, forged.occurredAt, forged);
    rows[1] = forged;
    expect(verifyAuditChain(rows)).toBe(2);
  });
});
