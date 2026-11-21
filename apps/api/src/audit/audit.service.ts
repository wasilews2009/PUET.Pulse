import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@puet/database';
import { PrismaService } from '../prisma/prisma.service';
import { computeAuditHash, type AuditEntry } from './audit-chain';

/** Arbitrary constant for pg_advisory_xact_lock: serializes appends to keep the chain linear. */
const AUDIT_CHAIN_LOCK = 0x50554554; // "PUET"

/**
 * Append-only audit log writer. The table rejects UPDATE/DELETE/TRUNCATE at the
 * database level; each row is chained to the previous one with SHA-256.
 * Export to SIEM (syslog/CEF or JSON) is added in Phase 2.
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
}
