import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@puet/database';
import type { Principal } from '@puet/policy-engine';
import { Action, BotCode, ResourceType } from '@puet/shared';
import { BotResolver } from '../authz/prisma-resolvers';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime.bus';
import { BOT_SLUGS, slugOf } from './bot-codes';

/**
 * Structured bot cards. The client renders each kind with its own component and treats every
 * string as text; cards carry ids and statuses, never HTML.
 */
export type BotCard =
  | { kind: 'document_request'; requestId: string; type: string; status: string; note?: string | null }
  | { kind: 'study_plan'; semester: string; status: string; credits: number | null; note?: string | null }
  | {
      kind: 'schedule_change';
      changeId: string;
      change: string;
      date: string;
      pair: number;
      discipline: string | null;
      group: string | null;
      room: string | null;
      newDate: string | null;
      newPair: number | null;
      link: string | null;
      note: string | null;
    }
  | { kind: 'ticket'; ticketId: string; number: number; title: string; status: string; event: string }
  | {
      kind: 'approval';
      routeId: string;
      fileId: string;
      title: string;
      status: string;
      event: 'your_turn' | 'approved' | 'rejected' | 'registered';
      registrationNo?: string | null;
    }
  | { kind: 'answer'; mode: 'extractive' | 'llm' | 'none'; sources: { ordinal: number; heading: string | null }[] };

export interface BotMessageDto {
  id: string;
  bot: string;
  direction: 'USER' | 'BOT';
  body: string | null;
  card: BotCard | null;
  createdAt: string;
  read: boolean;
}

const PAGE = 50;

/** Private per-person inboxes of the corporate bots. */
@Injectable()
export class BotInboxService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(BotResolver) private readonly bots: BotResolver,
  ) {}

  /** Writes one bot message to each person and tells their sockets (ids only). */
  async post(
    tenantId: string,
    userIds: readonly string[],
    bot: BotCode,
    content: { body?: string; card?: BotCard; expiresAt?: Date; direction?: 'USER' | 'BOT' },
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const userId of new Set(userIds)) {
      const row = await this.prisma.botMessage.create({
        data: {
          tenantId,
          userId,
          bot,
          direction: content.direction ?? 'BOT',
          body: content.body ?? null,
          card: (content.card ?? undefined) as Prisma.InputJsonValue | undefined,
          expiresAt: content.expiresAt ?? null,
          ...(content.direction === 'USER' ? { readAt: new Date() } : {}),
        },
        select: { id: true },
      });
      ids.push(row.id);
      await this.bus.emitToUsers([userId], 'bot.message', { bot: slugOf(bot), messageId: row.id });
    }
    return ids;
  }

  async list(principal: Principal, bot: BotCode, before?: string): Promise<BotMessageDto[]> {
    const now = new Date();
    const rows = await this.prisma.botMessage.findMany({
      where: {
        userId: principal.userId,
        tenantId: principal.tenantId,
        bot,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        ...(before ? { createdAt: { lt: new Date(before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: PAGE,
    });
    return rows.reverse().map((r) => ({
      id: r.id,
      bot: slugOf(r.bot as BotCode),
      direction: r.direction,
      body: r.body,
      card: (r.card as BotCard | null) ?? null,
      createdAt: r.createdAt.toISOString(),
      read: r.readAt !== null,
    }));
  }

  async markRead(principal: Principal, bot: BotCode): Promise<{ read: number }> {
    const res = await this.prisma.botMessage.updateMany({
      where: { userId: principal.userId, tenantId: principal.tenantId, bot, readAt: null },
      data: { readAt: new Date() },
    });
    return { read: res.count };
  }

  /** The bots this person may use, with unread counts. Each bot is decided by the policy engine. */
  async summary(principal: Principal) {
    const now = new Date();
    const out: { bot: string; unread: number; lastAt: string | null }[] = [];
    for (const slug of Object.keys(BOT_SLUGS)) {
      const resource = await this.bots.resolve(ResourceType.BOT, slug, principal);
      if (!resource) continue;
      const decision = await this.policy.evaluate(principal, Action.BOT_USE, resource, { now });
      if (!decision.allowed) continue;
      const code = BOT_SLUGS[slug]!;
      const live = { userId: principal.userId, tenantId: principal.tenantId, bot: code, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
      const [unread, last] = await Promise.all([
        this.prisma.botMessage.count({ where: { ...live, readAt: null } }),
        this.prisma.botMessage.findFirst({ where: live, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      ]);
      out.push({ bot: slug, unread, lastAt: last?.createdAt.toISOString() ?? null });
    }
    return out;
  }

  /** Daily purge of expired conversations (admissions Q&A). */
  async purgeExpired(now = new Date()): Promise<number> {
    const res = await this.prisma.botMessage.deleteMany({ where: { expiresAt: { lte: now } } });
    return res.count;
  }
}
