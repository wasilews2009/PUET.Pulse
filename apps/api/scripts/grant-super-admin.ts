/**
 * Grants SUPER_ADMIN to the first administrator, once, from the server console:
 *
 *   pnpm --filter @puet/api admin:bootstrap <corporate id>
 *
 * The admin panel can grant SUPER_ADMIN only to someone who already holds it,
 * so the first one is created here. The person must already exist (HR sync) and
 * be ACTIVE. The script refuses to run once any SUPER_ADMIN exists: further
 * administrators are granted in the admin panel, under separation of duties.
 * The grant is written to the audit log (actor: none, metadata: via console).
 */
import { PrismaClient } from '@puet/database';
import { RoleCode } from '@puet/shared';
import { AuditService } from '../src/audit/audit.service';

async function main() {
  const corporateId = process.argv[2]?.trim();
  if (!corporateId) throw new Error('Usage: admin:bootstrap <corporate id of an existing staff member>');
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.roleAssignment.count({ where: { role: RoleCode.SUPER_ADMIN } });
    if (existing > 0) throw new Error('A SUPER_ADMIN already exists; grant further administrators in the admin panel');
    const user = await prisma.user.findUnique({
      where: { corporateId },
      select: { id: true, tenantId: true, status: true, kind: true },
    });
    if (!user) throw new Error('No person with this corporate id; run the HR sync first');
    if (user.status !== 'ACTIVE' || user.kind !== 'STAFF') throw new Error('The person must be an ACTIVE staff member');
    const grant = await prisma.roleAssignment.create({
      data: { userId: user.id, tenantId: user.tenantId, role: RoleCode.SUPER_ADMIN, source: 'ADMIN' },
      select: { id: true },
    });
    await new AuditService(prisma as never).record({
      actorId: null,
      tenantId: user.tenantId,
      action: 'role.grant',
      resourceType: 'role',
      resourceId: grant.id,
      outcome: 'SUCCESS',
      metadata: { role: RoleCode.SUPER_ADMIN, userId: user.id, via: 'console-bootstrap' },
    });
    console.log('SUPER_ADMIN granted. Sign in with MFA (TOTP or WebAuthn) to open the admin panel.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
