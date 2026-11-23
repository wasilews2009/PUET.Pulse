import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@puet/database';
import { PrismaService } from '../prisma/prisma.service';
import { computeAuditHash, verifyAuditChain, type AuditEntry } from './audit-chain';

/** Arbitrary constant for pg_advisory_xact_lock: serializes appends to keep the chain linear. */
const AUDIT_CHAIN_LOCK = 0x50554554; // "PUET"

/**
 * Append-only audit log writer. The table rejects UPDATE/DELETE/TRUNCATE at the
 * database level; each row is chained to the previous one with SHA-256.
 * SIEM collectors pull it via GET /admin/tenants/:tenantId/audit (JSON, cursor-paginated).
 */
@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`;
      const last = await tx.auditLog.findFirst({ orderBy: { id: 'desc' }, select: { hash: true } });
      const prevHash = last?.hash ?? null;
      const occurredAt = new Date();
      const hash = computeAuditHash(prevHash, occurredAt, entry);
      await tx.auditLog.create({
        data: {
          occurredAt,
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
          metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          prevHash,
          hash,
        },
      });
    });
  }

  list(
    tenantId: string,
    q: { beforeId?: bigint; limit: number; action?: string; actorId?: string; outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE' },
  ) {
    return this.prisma.auditLog.findMany({
      where: {
        tenantId,
        ...(q.beforeId ? { id: { lt: q.beforeId } } : {}),
        ...(q.action ? { action: q.action } : {}),
        ...(q.actorId ? { actorId: q.actorId } : {}),
        ...(q.outcome ? { outcome: q.outcome } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit,
    });
  }

  /** Re-computes the hash chain for a range of rows. Returns the first broken row id, if any. */
  async verifyRange(fromId: bigint, limit: number) {
    const rows = await this.prisma.auditLog.findMany({
      where: { id: { gte: fromId } },
      orderBy: { id: 'asc' },
      take: limit,
    });
    const broken = verifyAuditChain(
      rows.map((r) => ({
        ...r,
        outcome: r.outcome,
        metadata: (r.metadata ?? null) as Record<string, unknown> | null,
      })),
    );
    return {
      checked: rows.length,
      fromId: rows[0]?.id.toString() ?? null,
      toId: rows.at(-1)?.id.toString() ?? null,
      intact: broken === -1,
      firstBrokenId: broken === -1 ? null : rows[broken]!.id.toString(),
    };
  }
}
