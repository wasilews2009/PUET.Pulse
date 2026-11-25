import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime.bus';
import { DIGEST_STORE, type DigestStore } from './digest.store';
import { decideNotification } from './quiet-hours';

export interface NotifiableMessage {
  id: string;
  channelId: string;
  senderId: string;
  isPriority: boolean;
}

/**
 * Sends `notification` events (the client turns them into sound / push) and
 * holds the rest for the morning digest. Socket payloads carry ids only; the
 * Web Push to phones adds the sender's and the chat's name (encrypted for the
 * device), never the message body, so E2EE and DLP rules are not weakened.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
    @Inject(DIGEST_STORE) private readonly digests: DigestStore,
    @Inject(PushService) private readonly push: PushService,
  ) {}

  /** Phone pushes of the last dispatch (tests await it; the request never waits for push services). */
  lastPush: Promise<number> = Promise.resolve(0);

  async dispatch(message: NotifiableMessage, recipientIds: readonly string[], now = new Date()): Promise<void> {
    const ids = recipientIds.filter((id) => id !== message.senderId);
    if (ids.length === 0) return;

    const [members, users] = await Promise.all([
      this.prisma.channelMember.findMany({
        where: { channelId: message.channelId, userId: { in: ids } },
        select: { userId: true, mutedUntil: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, presence: true, presenceUntil: true, quietHours: true },
      }),
    ]);
    const muted = new Map(members.map((m) => [m.userId, m.mutedUntil]));

    const loud: string[] = [];
    const silent: string[] = [];
    for (const u of users) {
      const decision = decideNotification(
        {
          presence: u.presence,
          presenceUntil: u.presenceUntil,
          mutedUntil: muted.get(u.id) ?? null,
          quietHours: u.quietHours,
        },
        message,
        now,
      );
      if (decision.action === 'deliver') (decision.silent ? silent : loud).push(u.id);
      else if (decision.action === 'defer') await this.digests.hold(u.id, message.channelId, decision.until);
    }

    const base = { channelId: message.channelId, messageId: message.id, priority: message.isPriority };
    if (loud.length) await this.bus.emitToUsers(loud, 'notification', { ...base, silent: false });
    if (silent.length) await this.bus.emitToUsers(silent, 'notification', { ...base, silent: true });
    // Phones in the background or with the app closed: Web Push naming the sender, never the text.
    this.lastPush = this.push.deliver(message, loud, silent, now);
  }

  /** Releases digests whose quiet window has ended. Returns how many users were notified. */
  async releaseDueDigests(now = new Date()): Promise<number> {
    const due = await this.digests.takeDue(now);
    for (const d of due) {
      const channels = Object.entries(d.channels).map(([channelId, count]) => ({ channelId, count }));
      await this.bus.emitToUsers([d.userId], 'notification.digest', { channels });
    }
    if (due.length) this.logger.log(`Released ${due.length} digests`);
    return due.length;
  }
}
