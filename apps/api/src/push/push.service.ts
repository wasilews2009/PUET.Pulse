import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import type { Principal } from '@puet/policy-engine';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { isAllowedPushEndpoint, PUSH_SENDER, type PushSender } from './push.sender';

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushMessage {
  id: string;
  channelId: string;
  senderId: string;
  isPriority: boolean;
}

/** What the service worker receives. Names only: never the message text (E2EE, DLP). */
export interface PushPayload {
  v: 1;
  type: 'message';
  channelId: string;
  messageId: string;
  /** The sender's name in the recipient's language. */
  sender: string;
  /** Group / channel name; null for a direct chat. */
  channel: string | null;
  priority: boolean;
  silent: boolean;
  /** Unread messages of the recipient, for the app icon badge. */
  badge: number;
  lang: 'uk' | 'en';
}

const NAME_MAX = 80;
const clip = (s: string) => (s.length > NAME_MAX ? `${s.slice(0, NAME_MAX - 1)}…` : s);

/**
 * Phone notifications over Web Push. A subscription belongs to the person who
 * signed in on that phone and to that session: logout removes it, offboarding
 * (session epoch) silences it, and it lapses unless the app is opened again
 * within PUSH_SUBSCRIPTION_DAYS. Pseudonyms of anonymous appeals never get one,
 * so a phone is never linked to an anonymous requester.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PUSH_SENDER) private readonly sender: PushSender,
  ) {}

  publicConfig() {
    return { enabled: !!this.config.push && this.sender.enabled, publicKey: this.config.push?.publicKey ?? null };
  }

  async subscribe(principal: Principal, sessionId: string, input: PushSubscriptionInput, now = new Date()) {
    const push = this.config.push;
    if (!push || !this.sender.enabled) throw new ForbiddenException('Access denied');
    if (principal.kind === 'PSEUDONYM') throw new ForbiddenException('Access denied');
    if (!isAllowedPushEndpoint(input.endpoint, push.endpointHosts)) throw new ForbiddenException('Access denied');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: principal.userId }, select: { sessionEpoch: true } });
    const expiresAt = new Date(now.getTime() + push.subscriptionDays * 86_400_000);
    const data = {
      userId: principal.userId,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      sessionId,
      sessionEpoch: user.sessionEpoch,
      expiresAt,
    };
    // The endpoint is the phone's browser: whoever signed in on it last owns it.
    await this.prisma.pushSubscription.upsert({ where: { endpoint: input.endpoint }, create: { endpoint: input.endpoint, ...data }, update: data });
    return { expiresAt: expiresAt.toISOString() };
  }

  async unsubscribe(principal: Principal, endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint, userId: principal.userId } });
  }

  async removeForSession(sessionId: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { sessionId } });
  }

  async removeForUser(userId: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { userId } });
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const { count } = await this.prisma.pushSubscription.deleteMany({ where: { expiresAt: { lte: now } } });
    return count;
  }

  /** Sends one push per subscribed phone of each recipient. Never throws. */
  async deliver(message: PushMessage, loud: readonly string[], silent: readonly string[], now = new Date()): Promise<number> {
    if (!this.config.push || !this.sender.enabled || loud.length + silent.length === 0) return 0;
    try {
      return await this.deliverUnsafe(message, loud, silent, now);
    } catch (e) {
      this.logger.warn(`push delivery failed: ${(e as Error).name}`);
      return 0;
    }
  }

  private async deliverUnsafe(message: PushMessage, loud: readonly string[], silent: readonly string[], now: Date) {
    const ids = [...new Set([...loud, ...silent])].filter((id) => id !== message.senderId);
    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId: { in: ids }, expiresAt: { gt: now } },
      select: { id: true, endpoint: true, p256dh: true, auth: true, userId: true, sessionEpoch: true, user: { select: { status: true, sessionEpoch: true, locale: true } } },
    });
    const live = subs.filter((s) => s.user.status === 'ACTIVE' && s.user.sessionEpoch === s.sessionEpoch);
    if (live.length === 0) return 0;

    const [sender, channel, badges] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: message.senderId }, select: { fullNameUk: true, fullNameEn: true } }),
      this.prisma.channel.findUniqueOrThrow({ where: { id: message.channelId }, select: { type: true, nameUk: true, nameEn: true } }),
      this.unreadTotals([...new Set(live.map((s) => s.userId))]),
    ]);
    const silentSet = new Set(silent);
    const channelName = (en: boolean) => {
      if (channel.type === 'DIRECT') return null;
      const name = (en ? channel.nameEn : null) ?? channel.nameUk;
      return name ? clip(name) : null;
    };
    let sent = 0;
    await Promise.all(
      live.map(async (s) => {
        const en = s.user.locale === 'en';
        const payload: PushPayload = {
          v: 1,
          type: 'message',
          channelId: message.channelId,
          messageId: message.id,
          sender: clip((en ? sender.fullNameEn : null) ?? sender.fullNameUk),
          channel: channelName(en),
          priority: message.isPriority,
          silent: silentSet.has(s.userId),
          badge: badges.get(s.userId) ?? 0,
          lang: en ? 'en' : 'uk',
        };
        const result = await this.sender.send(s, JSON.stringify(payload), {
          ttlSeconds: 86_400,
          urgency: payload.silent ? 'normal' : 'high',
        });
        if (result === 'ok') sent++;
        else if (result === 'gone') await this.prisma.pushSubscription.deleteMany({ where: { id: s.id } });
      }),
    );
    return sent;
  }

  /** Unread messages per person across their channels, muted ones excluded (same rule as the channel list). */
  async unreadTotals(userIds: string[]): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ user_id: string; n: bigint }[]>`
      SELECT cm.user_id, count(*) AS n
      FROM channel_members cm
      JOIN messages m ON m.channel_id = cm.channel_id
      WHERE cm.user_id = ANY(${userIds}::uuid[])
        AND (cm.expires_at IS NULL OR cm.expires_at > now())
        AND (cm.muted_until IS NULL OR cm.muted_until <= now())
        AND m.created_at > COALESCE(cm.last_read_at, cm.joined_at)
        AND m.sender_id <> cm.user_id
        AND m.deleted_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > now())
      GROUP BY cm.user_id`;
    return new Map(rows.map((r) => [r.user_id, Number(r.n)]));
  }
}
