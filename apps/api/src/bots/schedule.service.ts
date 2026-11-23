import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@puet/database';
import type { Principal } from '@puet/policy-engine';
import { BotCode } from '@puet/shared';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { SyncResult } from '../integrations/sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { BotInboxService, type BotCard } from './bot-inbox.service';
import type { ScheduleBatch } from './bots.schemas';

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Accepts only https links to the allowlisted hosts (Moodle, Zoom, ...), subdomains included. */
export function allowedLink(raw: string, hosts: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`)) ? url.toString() : null;
}

const changeInclude = {
  courseOffering: { select: { discipline: { select: { nameUk: true, nameEn: true } } } },
  academicGroup: { select: { code: true } },
} satisfies Prisma.ScheduleChangeInclude;
type ChangeRow = Prisma.ScheduleChangeGetPayload<{ include: typeof changeInclude }>;

function card(c: ChangeRow): BotCard {
  return {
    kind: 'schedule_change',
    changeId: c.id,
    change: c.kind,
    date: day(c.date),
    pair: c.pair,
    discipline: c.courseOffering?.discipline.nameUk ?? null,
    group: c.academicGroup?.code ?? null,
    room: c.room,
    newDate: c.newDate ? day(c.newDate) : null,
    newPair: c.newPair,
    link: c.link,
    note: c.note,
  };
}

/**
 * «Розклад ПУЕТ». The schedule system pushes changes (room changes, cancellations, moved or online
 * classes with a Moodle / Zoom link); the bot tells exactly the students and lecturers concerned,
 * resolved from current course offerings and groups at the time of the change.
 */
@Injectable()
export class ScheduleService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BotInboxService) private readonly inbox: BotInboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async ingest(tenantId: string, batch: ScheduleBatch): Promise<SyncResult> {
    const result: SyncResult = { created: 0, updated: 0, offboarded: 0, errors: [] };
    for (const [index, c] of batch.changes.entries()) {
      try {
        const offering = c.courseExternalId
          ? await this.prisma.courseOffering.findFirst({ where: { tenantId, externalId: c.courseExternalId }, select: { id: true } })
          : null;
        const group = c.groupCode
          ? await this.prisma.academicGroup.findFirst({ where: { tenantId, code: c.groupCode }, select: { id: true } })
          : null;
        if (c.courseExternalId && !offering) throw new Error('course.not_found');
        if (c.groupCode && !group) throw new Error('group.not_found');
        let link: string | null = null;
        if (c.link) {
          link = allowedLink(c.link, this.config.bots.scheduleLinkHosts);
          if (!link) throw new Error('link.not_allowed');
        }
        let row: ChangeRow;
        try {
          row = await this.prisma.scheduleChange.create({
            data: {
              tenantId,
              externalId: c.externalId,
              courseOfferingId: offering?.id ?? null,
              academicGroupId: group?.id ?? null,
              date: new Date(`${c.date}T00:00:00Z`),
              pair: c.pair,
              kind: c.kind,
              room: c.room ?? null,
              newDate: c.newDate ? new Date(`${c.newDate}T00:00:00Z`) : null,
              newPair: c.newPair ?? null,
              link,
              note: c.note ?? null,
            },
            include: changeInclude,
          });
        } catch (e) {
          // Same externalId again: already announced.
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
          throw e;
        }
        result.created++;
        const recipients = await this.recipients(tenantId, offering?.id ?? null, group?.id ?? null);
        await this.inbox.post(tenantId, recipients, BotCode.SCHEDULE, { card: card(row) });
      } catch (err) {
        const msg = (err as Error).message;
        result.errors.push({ index, error: ['course.not_found', 'group.not_found', 'link.not_allowed'].includes(msg) ? msg : 'change.failed' });
      }
    }
    return result;
  }

  /** Active students of the groups and the lecturers of the offering (or of the group's current offerings). */
  private async recipients(tenantId: string, offeringId: string | null, groupId: string | null): Promise<string[]> {
    const groupIds = new Set<string>();
    const offeringIds = new Set<string>();
    if (offeringId) {
      offeringIds.add(offeringId);
      const groups = await this.prisma.courseOfferingGroup.findMany({ where: { courseOfferingId: offeringId }, select: { academicGroupId: true } });
      groups.forEach((g) => groupIds.add(g.academicGroupId));
    }
    if (groupId) {
      groupIds.add(groupId);
      if (!offeringId) {
        const current = await this.prisma.courseOffering.findMany({
          where: { tenantId, semester: { isCurrent: true }, groups: { some: { academicGroupId: groupId } } },
          select: { id: true },
        });
        current.forEach((o) => offeringIds.add(o.id));
      }
    }
    const [students, lecturers] = await Promise.all([
      this.prisma.user.findMany({
        where: { tenantId, status: 'ACTIVE', studentProfile: { academicGroupId: { in: [...groupIds] } } },
        select: { id: true },
      }),
      this.prisma.user.findMany({
        where: { tenantId, status: 'ACTIVE', staffProfile: { teaching: { some: { courseOfferingId: { in: [...offeringIds] } } } } },
        select: { id: true },
      }),
    ]);
    return [...students, ...lecturers].map((u) => u.id);
  }

  /** Changes from yesterday on, for the caller's current courses and group. */
  async mine(principal: Principal, now = new Date()) {
    const from = new Date(`${day(new Date(now.getTime() - 86_400_000))}T00:00:00Z`);
    const rows = await this.prisma.scheduleChange.findMany({
      where: {
        tenantId: principal.tenantId,
        OR: [
          { date: { gte: from } },
          { newDate: { gte: from } },
        ],
        AND: [
          {
            OR: [
              { courseOfferingId: { in: principal.activeCourseOfferingIds } },
              { academicGroupId: { in: principal.academicGroupIds } },
            ],
          },
        ],
      },
      include: changeInclude,
      orderBy: [{ date: 'asc' }, { pair: 'asc' }],
      take: 100,
    });
    return rows.map(card);
  }
}
