import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@puet/database';
import type { Principal, Resource } from '@puet/policy-engine';
import { Action, ChannelType, E2eeMode, MemberRole, ResourceType } from '@puet/shared';
import { AuditService } from '../audit/audit.service';
import { UserTargetResolver } from '../authz/prisma-resolvers';
import { NotificationService } from '../notifications/notification.service';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime.bus';
import type { EditMessageInput, SendMessageInput } from './messaging.schemas';

const messageSelect = {
  id: true,
  channelId: true,
  senderId: true,
  senderDeviceId: true,
  threadRootId: true,
  scheme: true,
  body: true,
  ciphertext: true,
  isPriority: true,
  createdAt: true,
  editedAt: true,
  expiresAt: true,
  deletedAt: true,
} as const;
type MessageRow = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

export interface MessageDto {
  id: string;
  channelId: string;
  senderId: string;
  senderDeviceId: string | null;
  threadRootId: string | null;
  scheme: string;
  body: string | null;
  /** Base64 of the opaque vodozemac payload. */
  ciphertext: string | null;
  isPriority: boolean;
  createdAt: string;
  editedAt: string | null;
  expiresAt: string | null;
  deleted: boolean;
}

export function toDto(m: MessageRow): MessageDto {
  return {
    id: m.id,
    channelId: m.channelId,
    senderId: m.senderId,
    senderDeviceId: m.senderDeviceId,
    threadRootId: m.threadRootId,
    scheme: m.scheme,
    body: m.deletedAt ? null : m.body,
    ciphertext: m.deletedAt || !m.ciphertext ? null : Buffer.from(m.ciphertext).toString('base64'),
    isPriority: m.isPriority,
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt?.toISOString() ?? null,
    expiresAt: m.expiresAt?.toISOString() ?? null,
    deleted: m.deletedAt !== null,
  };
}

const notExpired = (now: Date) => ({ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });
const activeMembership = (now: Date) => ({ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

/** Members that may receive events of a channel right now. Resolved per event (zero trust). */
async function currentRecipients(prisma: PrismaService, channelId: string, now = new Date()): Promise<string[]> {
  const rows = await prisma.channelMember.findMany({
    where: { channelId, ...activeMembership(now), user: { status: 'ACTIVE' } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/**
 * Messages, threads, read markers, direct chats and private groups.
 * Every method receives the resource the PolicyGuard already authorized and
 * scopes its queries by that resource's id and tenant.
 */
@Injectable()
export class MessagingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(UserTargetResolver) private readonly users: UserTargetResolver,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ───────────────────────────── Reading ─────────────────────────────

  async myChannels(principal: Principal) {
    const now = new Date();
    const memberships = await this.prisma.channelMember.findMany({
      where: { userId: principal.userId, ...activeMembership(now) },
      select: {
        role: true,
        lastReadAt: true,
        mutedUntil: true,
        channel: {
          select: {
            id: true,
            type: true,
            e2eeMode: true,
            nameUk: true,
            nameEn: true,
            topic: true,
            isOfficial: true,
            confidential: true,
            threadsRequired: true,
            messageTtlSeconds: true,
            archivedAt: true,
            directKey: true,
          },
        },
      },
    });
    const unread = await this.prisma.$queryRaw<{ channel_id: string; n: bigint }[]>`
      SELECT m.channel_id, count(*) AS n
      FROM messages m
      JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ${principal.userId}::uuid
      WHERE m.created_at > COALESCE(cm.last_read_at, cm.joined_at)
        AND m.sender_id <> ${principal.userId}::uuid
        AND m.deleted_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > now())
      GROUP BY m.channel_id`;
    const unreadBy = new Map(unread.map((u) => [u.channel_id, Number(u.n)]));

    return memberships.map(({ channel: c, role, lastReadAt, mutedUntil }) => ({
      id: c.id,
      type: c.type,
      e2eeMode: c.e2eeMode,
      nameUk: c.nameUk,
      nameEn: c.nameEn,
      topic: c.topic,
      isOfficial: c.isOfficial,
      confidential: c.confidential,
      threadsRequired: c.threadsRequired,
      messageTtlSeconds: c.messageTtlSeconds,
      archived: c.archivedAt !== null,
      /** For DIRECT chats: the other participant. */
      peerId: c.directKey ? (c.directKey.split(':').find((id) => id !== principal.userId) ?? null) : null,
      role,
      lastReadAt: lastReadAt?.toISOString() ?? null,
      mutedUntil: mutedUntil && mutedUntil > now ? mutedUntil.toISOString() : null,
      unread: unreadBy.get(c.id) ?? 0,
    }));
  }

  async history(channelId: string, q: { before?: string; limit: number; threadRootId?: string }) {
    const now = new Date();
    const rows = await this.prisma.message.findMany({
      where: {
        channelId,
        ...notExpired(now),
        // Top-level timeline by default; a thread when threadRootId is given.
        threadRootId: q.threadRootId ?? null,
        ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
      select: { ...messageSelect, _count: { select: { replies: { where: { deletedAt: null } } } } },
    });
    return rows.map(({ _count, ...m }) => ({ ...toDto(m), replyCount: _count.replies }));
  }

  async members(channelId: string) {
    const now = new Date();
    const rows = await this.prisma.channelMember.findMany({
      where: { channelId, ...activeMembership(now), user: { status: 'ACTIVE' } },
      select: { userId: true, role: true },
      orderBy: { joinedAt: 'asc' },
    });
    return rows;
  }

  // ───────────────────────────── Writing ─────────────────────────────

  async send(principal: Principal, channel: Resource, input: SendMessageInput): Promise<MessageDto> {
    const channelId = channel.id!;
    const row = await this.prisma.channel.findFirst({
      where: { id: channelId, tenantId: channel.tenantId },
      select: { e2eeMode: true, threadsRequired: true, messageTtlSeconds: true, type: true, orgUnit: { select: { bypassesQuietHours: true } } },
    });
    if (!row) throw new NotFoundException();

    this.checkPayloadMode(row.e2eeMode, input);
    if (input.senderDeviceId) await this.checkOwnDevice(principal, input.senderDeviceId);

    if (input.threadRootId) {
      const root = await this.prisma.message.findFirst({
        where: { id: input.threadRootId, channelId, threadRootId: null, deletedAt: null },
        select: { id: true },
      });
      if (!root) throw new BadRequestException('Unknown thread');
    } else if (row.threadsRequired) {
      // Course channels: lecturers open topics, everybody else discusses in threads.
      const moderator = channel.memberRole === MemberRole.OWNER || channel.memberRole === MemberRole.MODERATOR;
      if (!moderator) throw new ForbiddenException('Reply in a thread');
    }

    if (input.clientMessageId) {
      const existing = await this.prisma.message.findUnique({
        where: { senderId_clientMessageId: { senderId: principal.userId, clientMessageId: input.clientMessageId } },
        select: messageSelect,
      });
      if (existing) {
        if (existing.channelId !== channelId) throw new BadRequestException('clientMessageId already used');
        return toDto(existing);
      }
    }

    const now = new Date();
    const isPriority = row.type === ChannelType.EMERGENCY || row.orgUnit?.bypassesQuietHours === true;
    let created: MessageRow;
    try {
      created = await this.prisma.message.create({
        data: {
          channelId,
          senderId: principal.userId,
          threadRootId: input.threadRootId ?? null,
          body: input.body ?? null,
          ciphertext: input.ciphertext ? Buffer.from(input.ciphertext, 'base64') : null,
          scheme: input.ciphertext ? input.scheme! : 'NONE',
          senderDeviceId: input.senderDeviceId ?? null,
          clientMessageId: input.clientMessageId ?? null,
          isPriority,
          expiresAt: row.messageTtlSeconds ? new Date(now.getTime() + row.messageTtlSeconds * 1000) : null,
        },
        select: messageSelect,
      });
    } catch (e) {
      // Concurrent retry with the same clientMessageId.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && input.clientMessageId) {
        const existing = await this.prisma.message.findUniqueOrThrow({
          where: { senderId_clientMessageId: { senderId: principal.userId, clientMessageId: input.clientMessageId } },
          select: messageSelect,
        });
        return toDto(existing);
      }
      throw e;
    }

    const dto = toDto(created);
    const recipients = await currentRecipients(this.prisma, channelId, now);
    await this.bus.emitToUsers(recipients, 'message.new', dto);
    await this.notifications.dispatch(
      { id: created.id, channelId, senderId: principal.userId, isPriority },
      recipients,
      now,
    );
    if (isPriority) {
      await this.audit.record({
        actorId: principal.userId,
        tenantId: channel.tenantId,
        action: 'message.priority.send',
        resourceType: ResourceType.CHANNEL,
        resourceId: channelId,
        outcome: 'SUCCESS',
        metadata: { messageId: created.id, recipients: recipients.length },
      });
    }
    return dto;
  }

  async edit(principal: Principal, message: Resource, input: EditMessageInput): Promise<MessageDto> {
    const current = await this.prisma.message.findFirst({
      where: { id: message.id!, deletedAt: null, channel: { tenantId: message.tenantId } },
      select: { channelId: true, scheme: true, channel: { select: { e2eeMode: true } } },
    });
    if (!current) throw new NotFoundException();
    // An edit keeps the storage scheme of the original message.
    if ((current.scheme === 'NONE') !== (input.body !== undefined)) {
      throw new BadRequestException('Edit must use the same encryption as the original message');
    }
    if (input.senderDeviceId) await this.checkOwnDevice(principal, input.senderDeviceId);

    const updated = await this.prisma.message.update({
      where: { id: message.id! },
      data: {
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.ciphertext !== undefined
          ? { ciphertext: Buffer.from(input.ciphertext, 'base64'), senderDeviceId: input.senderDeviceId! }
          : {}),
        editedAt: new Date(),
      },
      select: messageSelect,
    });
    const dto = toDto(updated);
    await this.bus.emitToUsers(await currentRecipients(this.prisma, current.channelId), 'message.updated', dto);
    return dto;
  }

  async remove(principal: Principal, message: Resource): Promise<{ id: string; deleted: true }> {
    const current = await this.prisma.message.findFirst({
      where: { id: message.id!, deletedAt: null, channel: { tenantId: message.tenantId } },
      select: { channelId: true, senderId: true },
    });
    if (!current) throw new NotFoundException();
    // Tombstone: the content is erased, the fact that a message existed stays for threads.
    await this.prisma.message.update({
      where: { id: message.id! },
      data: { deletedAt: new Date(), body: null, ciphertext: null },
    });
    if (current.senderId !== principal.userId) {
      await this.audit.record({
        actorId: principal.userId,
        tenantId: message.tenantId,
        action: 'message.moderate.delete',
        resourceType: ResourceType.MESSAGE,
        resourceId: message.id!,
        outcome: 'SUCCESS',
        metadata: { channelId: current.channelId },
      });
    }
    await this.bus.emitToUsers(await currentRecipients(this.prisma, current.channelId), 'message.deleted', {
      id: message.id,
      channelId: current.channelId,
    });
    return { id: message.id!, deleted: true };
  }

  async markRead(principal: Principal, channelId: string, messageId?: string) {
    let at = new Date();
    if (messageId) {
      const m = await this.prisma.message.findFirst({ where: { id: messageId, channelId }, select: { createdAt: true } });
      if (!m) throw new BadRequestException('Unknown message');
      at = m.createdAt;
    }
    await this.prisma.channelMember.update({
      where: { channelId_userId: { channelId, userId: principal.userId } },
      data: { lastReadAt: at },
    });
    // Keep the user's other devices in sync. Read receipts are not shown to others.
    await this.bus.emitToUsers([principal.userId], 'channel.read', { channelId, lastReadAt: at.toISOString() });
    return { channelId, lastReadAt: at.toISOString() };
  }

  async mute(principal: Principal, channelId: string, mutedUntil: string | null) {
    await this.prisma.channelMember.update({
      where: { channelId_userId: { channelId, userId: principal.userId } },
      data: { mutedUntil: mutedUntil ? new Date(mutedUntil) : null },
    });
    return { channelId, mutedUntil };
  }

  async typing(principal: Principal, channelId: string) {
    const recipients = (await currentRecipients(this.prisma, channelId)).filter((id) => id !== principal.userId);
    await this.bus.emitToUsers(recipients, 'typing', { channelId, userId: principal.userId });
  }

  // ─────────────────────── Direct chats and groups ───────────────────────

  /** Finds or creates the one DIRECT chat of a pair. DM_START was checked by the guard. */
  async startDirect(principal: Principal, target: Resource) {
    const peerId = target.id!;
    const directKey = [principal.userId, peerId].sort().join(':');
    const existing = await this.prisma.channel.findUnique({ where: { directKey }, select: { id: true } });
    if (existing) return { channelId: existing.id, created: false };
    try {
      const channel = await this.prisma.channel.create({
        data: {
          tenantId: principal.tenantId,
          type: ChannelType.DIRECT,
          e2eeMode: E2eeMode.OPTIONAL,
          directKey,
          createdById: principal.userId,
          members: {
            create: [
              { userId: principal.userId, role: MemberRole.OWNER },
              { userId: peerId, role: MemberRole.OWNER },
            ],
          },
        },
        select: { id: true },
      });
      await this.bus.emitToUsers([principal.userId, peerId], 'channel.joined', { channelId: channel.id });
      return { channelId: channel.id, created: true };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.prisma.channel.findUniqueOrThrow({ where: { directKey }, select: { id: true } });
        return { channelId: again.id, created: false };
      }
      throw e;
    }
  }

  async createGroup(
    principal: Principal,
    input: { nameUk: string; nameEn?: string; memberIds: string[]; encrypted: boolean; messageTtlSeconds?: number },
  ) {
    const others = [...new Set(input.memberIds)].filter((id) => id !== principal.userId);
    await this.assertMayAdd(principal, others);
    const channel = await this.prisma.channel.create({
      data: {
        tenantId: principal.tenantId,
        type: ChannelType.PRIVATE_GROUP,
        // OPTIONAL: clients encrypt; DISABLED would make the chat readable by the server.
        e2eeMode: input.encrypted ? E2eeMode.OPTIONAL : E2eeMode.DISABLED,
        nameUk: input.nameUk,
        nameEn: input.nameEn ?? null,
        messageTtlSeconds: input.messageTtlSeconds ?? null,
        createdById: principal.userId,
        members: {
          create: [
            { userId: principal.userId, role: MemberRole.OWNER },
            ...others.map((userId) => ({ userId, role: MemberRole.MEMBER })),
          ],
        },
      },
      select: { id: true },
    });
    await this.bus.emitToUsers([principal.userId, ...others], 'channel.joined', { channelId: channel.id });
    return { channelId: channel.id };
  }

  async addMembers(principal: Principal, channel: Resource, userIds: string[]) {
    if (channel.channelType !== ChannelType.PRIVATE_GROUP) {
      throw new BadRequestException('Members of this channel are managed automatically');
    }
    const ids = [...new Set(userIds)].filter((id) => id !== principal.userId);
    await this.assertMayAdd(principal, ids);
    const count = await this.prisma.channelMember.count({ where: { channelId: channel.id! } });
    if (count + ids.length > 256) throw new BadRequestException('A private group has at most 256 members');
    await this.prisma.channelMember.createMany({
      data: ids.map((userId) => ({ channelId: channel.id!, userId, role: MemberRole.MEMBER })),
      skipDuplicates: true,
    });
    await this.bus.emitToUsers(ids, 'channel.joined', { channelId: channel.id });
    await this.bus.emitToUsers(await currentRecipients(this.prisma, channel.id!), 'channel.members_changed', {
      channelId: channel.id,
    });
    return { added: ids.length };
  }

  async removeMember(principal: Principal, channel: Resource, userId: string) {
    const member = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId: channel.id!, userId } },
      select: { source: true, role: true },
    });
    if (!member) throw new NotFoundException();
    if (member.source === 'AUTO' || channel.channelType === ChannelType.DIRECT) {
      throw new BadRequestException('This membership is managed automatically');
    }
    if (member.role === MemberRole.OWNER && userId !== principal.userId) {
      throw new ForbiddenException('Access denied');
    }
    await this.prisma.channelMember.delete({ where: { channelId_userId: { channelId: channel.id!, userId } } });
    await this.bus.emitToUsers([userId], 'channel.left', { channelId: channel.id });
    // Remaining members must rotate the Megolm session so the removed user cannot read new messages.
    await this.bus.emitToUsers(await currentRecipients(this.prisma, channel.id!), 'channel.members_changed', {
      channelId: channel.id,
      rotateKeys: true,
    });
    return { removed: userId };
  }

  async leave(principal: Principal, channel: Resource) {
    if (channel.channelType !== ChannelType.PRIVATE_GROUP) {
      throw new BadRequestException('This membership is managed automatically');
    }
    return this.removeMember(principal, channel, principal.userId);
  }

  async update(channel: Resource, input: { nameUk?: string; nameEn?: string | null; topic?: string | null; messageTtlSeconds?: number | null }) {
    if (input.messageTtlSeconds !== undefined && channel.e2eeMode !== E2eeMode.OPTIONAL && input.messageTtlSeconds !== null) {
      throw new BadRequestException('Self-destruct timers are available only in private chats');
    }
    if ((input.nameUk !== undefined || input.nameEn !== undefined) && channel.channelType !== ChannelType.PRIVATE_GROUP) {
      throw new BadRequestException('Names of official channels come from the university structure');
    }
    const row = await this.prisma.channel.update({
      where: { id: channel.id! },
      data: {
        ...(input.nameUk !== undefined ? { nameUk: input.nameUk } : {}),
        ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
        ...(input.topic !== undefined ? { topic: input.topic } : {}),
        ...(input.messageTtlSeconds !== undefined ? { messageTtlSeconds: input.messageTtlSeconds } : {}),
      },
      select: { id: true, nameUk: true, nameEn: true, topic: true, messageTtlSeconds: true },
    });
    await this.bus.emitToUsers(await currentRecipients(this.prisma, channel.id!), 'channel.updated', row);
    return row;
  }

  // ───────────────────────────── Helpers ─────────────────────────────

  private checkPayloadMode(mode: string, input: SendMessageInput) {
    if (mode === E2eeMode.MANDATORY && input.ciphertext === undefined) {
      throw new BadRequestException('This channel requires end-to-end encryption');
    }
    if (mode === E2eeMode.DISABLED && input.ciphertext !== undefined) {
      throw new BadRequestException('This channel is not end-to-end encrypted');
    }
  }

  private async checkOwnDevice(principal: Principal, deviceId: string) {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, userId: principal.userId, revokedAt: null },
      select: { id: true },
    });
    if (!device) throw new BadRequestException('Unknown device');
  }

  /**
   * Adding someone to a private group is contact, so it follows the DM rules
   * (minor protection, no students → Rectorate, guests, tenants). The error does
   * not say which person failed: no directory probing through group invites.
   */
  private async assertMayAdd(principal: Principal, userIds: string[]) {
    for (const userId of userIds) {
      const target = await this.users.resolve(ResourceType.USER, userId);
      const decision = target
        ? await this.policy.evaluate(principal, Action.DM_START, target, { now: new Date() })
        : { allowed: false, reason: 'resource.not_found' };
      if (!decision.allowed) {
        await this.audit.record({
          actorId: principal.userId,
          tenantId: principal.tenantId,
          action: Action.CHANNEL_MEMBERS_MANAGE,
          resourceType: ResourceType.USER,
          resourceId: userId,
          outcome: 'DENIED',
          reason: decision.reason,
        });
        throw new ForbiddenException('Access denied');
      }
    }
  }
}
