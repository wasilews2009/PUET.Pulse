import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@puet/database';
import type { Principal, Resource } from '@puet/policy-engine';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { PrincipalFactory } from '../auth/principal.factory';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime.bus';

/** No 0/O, 1/I: the alias is read aloud on the phone sometimes. */
const ALIAS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MAX_OPEN_CASES = 5;

export interface TrustCaseDto {
  id: string;
  alias: string;
  status: 'OPEN' | 'CLOSED';
  service: { id: string; nameUk: string; nameEn: string | null };
  channelId: string;
  /** The user id the client acts as for this appeal (X-Pulse-Persona). */
  pseudonymId: string;
  createdAt: string;
  closedAt: string | null;
}

type CaseRow = Prisma.AnonymousCaseGetPayload<{ include: { orgUnit: { select: { id: true; nameUk: true; nameEn: true } } } }>;

const toDto = (c: CaseRow): TrustCaseDto => ({
  id: c.id,
  alias: c.alias,
  status: c.status,
  service: { id: c.orgUnit.id, nameUk: c.orgUnit.nameUk, nameEn: c.orgUnit.nameEn },
  channelId: c.channelId,
  pseudonymId: c.pseudonymId,
  createdAt: c.createdAt.toISOString(),
  closedAt: c.closedAt?.toISOString() ?? null,
});

/**
 * Anonymous appeals to the trust services (Ombudsman, Psychological Service,
 * Military Registration). For each appeal the server creates a pseudonym: a
 * PSEUDONYM user with no profile, the ANONYMOUS_REQUESTER role and one
 * membership, in a MANDATORY E2EE trust room with the service's officers. The
 * person's browser acts as that pseudonym (header X-Pulse-Persona) with its own
 * E2EE device, so neither the officers nor the key directory see who it is.
 *
 * The link person → appeal is an HMAC tag under TRUST_INTAKE_SECRET, never a
 * user id, and it is not written to the audit log.
 */
@Injectable()
export class TrustIntakeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PrincipalFactory) private readonly principals: PrincipalFactory,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
  ) {}

  private tag(userId: string): string {
    const secret = this.config.trustIntakeSecret;
    if (!secret) throw new ServiceUnavailableException('Anonymous appeals are not configured');
    return createHmac('sha256', secret).update(`puet-trust-intake.v1:${userId}`).digest('hex');
  }

  get enabled() {
    return !!this.config.trustIntakeSecret;
  }

  /** Trust services of the caller's tenant that take anonymous appeals and have someone on duty. */
  async services(principal: Principal) {
    const rows = await this.prisma.orgUnit.findMany({
      where: { tenantId: principal.tenantId, kind: 'TRUST_SERVICE', anonymousIntake: true, isActive: true, members: { some: { staffProfile: { user: { status: 'ACTIVE' } } } } },
      select: { id: true, code: true, nameUk: true, nameEn: true },
      orderBy: { nameUk: 'asc' },
    });
    return { enabled: this.enabled, services: rows };
  }

  async mine(principal: Principal): Promise<TrustCaseDto[]> {
    if (!this.enabled) return [];
    const rows = await this.prisma.anonymousCase.findMany({
      where: { tenantId: principal.tenantId, requesterTag: this.tag(principal.userId) },
      include: { orgUnit: { select: { id: true, nameUk: true, nameEn: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map(toDto);
  }

  async open(principal: Principal, orgUnitId: string, now = new Date()): Promise<TrustCaseDto> {
    const tag = this.tag(principal.userId);
    const service = await this.prisma.orgUnit.findFirst({
      where: { id: orgUnitId, tenantId: principal.tenantId, kind: 'TRUST_SERVICE', anonymousIntake: true, isActive: true },
      select: { id: true },
    });
    if (!service) throw new NotFoundException('Not found');
    const officers = await this.prisma.user.findMany({
      where: { tenantId: principal.tenantId, status: 'ACTIVE', kind: 'STAFF', id: { not: principal.userId }, staffProfile: { orgUnits: { some: { orgUnitId } } } },
      select: { id: true },
    });
    if (officers.length === 0) throw new ConflictException('The service has nobody on duty in the messenger');
    const open = await this.prisma.anonymousCase.count({ where: { requesterTag: tag, status: 'OPEN' } });
    if (open >= MAX_OPEN_CASES) throw new ConflictException('Close an earlier appeal first');
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: principal.userId }, select: { isMinor: true, locale: true } });

    for (let attempt = 0; attempt < 5; attempt++) {
      const alias = Array.from({ length: 4 }, () => ALIAS_ALPHABET[randomInt(ALIAS_ALPHABET.length)]).join('');
      const pseudonymId = randomUUID();
      try {
        const row = await this.prisma.$transaction(async (tx) => {
          await tx.user.create({
            data: {
              id: pseudonymId,
              tenantId: principal.tenantId,
              corporateId: `ANON-${pseudonymId}`,
              kind: 'PSEUDONYM',
              fullNameUk: `Анонімний заявник · ${alias}`,
              fullNameEn: `Anonymous requester · ${alias}`,
              email: `${pseudonymId}@anonymous.invalid`,
              // Minor protection keeps applying behind the pseudonym.
              isMinor: me.isMinor,
              locale: me.locale,
            },
          });
          await tx.roleAssignment.create({ data: { userId: pseudonymId, tenantId: principal.tenantId, role: 'ANONYMOUS_REQUESTER', source: 'ADMIN' } });
          const channel = await tx.channel.create({
            data: {
              tenantId: principal.tenantId,
              type: 'TRUST_ROOM',
              e2eeMode: 'MANDATORY',
              confidential: true,
              nameUk: `Анонімне звернення · ${alias}`,
              nameEn: `Anonymous appeal · ${alias}`,
            },
          });
          const c = await tx.anonymousCase.create({
            data: { tenantId: principal.tenantId, orgUnitId, channelId: channel.id, pseudonymId, requesterTag: tag, alias, createdAt: now },
            include: { orgUnit: { select: { id: true, nameUk: true, nameEn: true } } },
          });
          await tx.channelMember.createMany({
            data: [
              { channelId: channel.id, userId: pseudonymId, role: 'MEMBER' },
              ...officers.map((o) => ({ channelId: channel.id, userId: o.id, role: 'MODERATOR' as const })),
            ],
          });
          return c;
        });
        // The audit names the pseudonym, never the person behind it.
        await this.audit.record({
          actorId: pseudonymId,
          tenantId: principal.tenantId,
          action: 'trust.intake',
          resourceType: 'channel',
          resourceId: row.channelId,
          outcome: 'SUCCESS',
          metadata: { orgUnitId, alias },
        });
        await this.bus.emitToUsers([...officers.map((o) => o.id), pseudonymId], 'channel.joined', { channelId: row.channelId });
        return toDto(row);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue; // alias taken
        throw e;
      }
    }
    throw new ConflictException('Please try again');
  }

  /** The requester closes their appeal: the room becomes read-only for everyone. */
  async closeOwn(principal: Principal, caseId: string, now = new Date()) {
    const c = await this.prisma.anonymousCase.findFirst({ where: { id: caseId, tenantId: principal.tenantId, requesterTag: this.tag(principal.userId) } });
    if (!c) throw new ForbiddenException('Access denied');
    return this.close(c.id, c.pseudonymId, now);
  }

  /** An officer (channel moderator) closes the appeal of their room. */
  async closeByOfficer(principal: Principal, channel: Resource, now = new Date()) {
    const c = await this.prisma.anonymousCase.findFirst({ where: { channelId: channel.id!, tenantId: channel.tenantId } });
    if (!c) throw new NotFoundException('Not found');
    return this.close(c.id, principal.userId, now);
  }

  private async close(caseId: string, actorId: string, now: Date) {
    const c = await this.prisma.anonymousCase.findUniqueOrThrow({ where: { id: caseId }, include: { orgUnit: { select: { id: true, nameUk: true, nameEn: true } } } });
    if (c.status === 'CLOSED') return toDto(c);
    const [row] = await this.prisma.$transaction([
      this.prisma.anonymousCase.update({ where: { id: caseId }, data: { status: 'CLOSED', closedAt: now }, include: { orgUnit: { select: { id: true, nameUk: true, nameEn: true } } } }),
      this.prisma.channel.update({ where: { id: c.channelId }, data: { archivedAt: now } }),
    ]);
    await this.audit.record({ actorId, tenantId: c.tenantId, action: 'trust.case.close', resourceType: 'channel', resourceId: c.channelId, outcome: 'SUCCESS' });
    return toDto(row);
  }

  /**
   * The principal to act as for X-Pulse-Persona: the pseudonym of one of the
   * caller's own appeals. Anything else is refused the same way.
   */
  async persona(real: Principal, pseudonymId: string): Promise<Principal> {
    if (!this.enabled || real.kind === 'PSEUDONYM' || real.status !== 'ACTIVE') throw new ForbiddenException('Access denied');
    const c = await this.prisma.anonymousCase.findFirst({
      where: { pseudonymId, tenantId: real.tenantId, requesterTag: this.tag(real.userId) },
      select: { id: true },
    });
    if (!c) throw new ForbiddenException('Access denied');
    const built = await this.principals.build(pseudonymId, { mfaVerified: false });
    if (!built) throw new ForbiddenException('Access denied');
    return built.principal;
  }

  /** Offboarding: the person's open appeals are closed and their pseudonyms deactivated. */
  async offboard(userId: string, now = new Date()) {
    if (!this.enabled) return 0;
    const rows = await this.prisma.anonymousCase.findMany({ where: { requesterTag: this.tag(userId) }, select: { id: true, status: true, pseudonymId: true } });
    for (const r of rows) {
      if (r.status === 'OPEN') await this.close(r.id, r.pseudonymId, now);
      await this.prisma.user.update({ where: { id: r.pseudonymId }, data: { status: 'OFFBOARDED', offboardedAt: now, sessionEpoch: { increment: 1 } } });
    }
    return rows.length;
  }

  /** Pseudonyms the caller acts as, so their realtime events reach the person's sockets. */
  async pseudonymsOf(userId: string): Promise<string[]> {
    if (!this.enabled) return [];
    const rows = await this.prisma.anonymousCase.findMany({ where: { requesterTag: this.tag(userId) }, select: { pseudonymId: true } });
    return rows.map((r) => r.pseudonymId);
  }
}
