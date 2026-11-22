import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@puet/database';
import type { Principal, Resource } from '@puet/policy-engine';
import { Action, MemberRole, ResourceType } from '@puet/shared';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { PrincipalFactory } from '../auth/principal.factory';
import { ChannelScopedResolver } from '../authz/prisma-resolvers';
import { currentRecipients, messageSelect, toDto } from '../messaging/messaging.service';
import { NotificationService } from '../notifications/notification.service';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime.bus';
import { MEDIA_SERVER, type MediaServer } from './media-server';

/** Join tokens only open the door: LiveKit checks them at connect time. Kept short. */
export const JOIN_TOKEN_TTL_SECONDS = 300;
/** A consultation room opens this long before the slot and stays open this long after it. */
export const CONSULTATION_EARLY_MS = 10 * 60_000;
export const CONSULTATION_GRACE_MS = 15 * 60_000;
/** A channel call nobody is in for this long is ended. */
const ABANDONED_MS = 10 * 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const callSelect = {
  id: true,
  tenantId: true,
  kind: true,
  channelId: true,
  slotId: true,
  messageId: true,
  startedById: true,
  roomName: true,
  startedAt: true,
  endedAt: true,
  participants: { select: { userId: true }, orderBy: { firstJoinedAt: 'asc' } },
  slot: { select: { hostId: true, startsAt: true, endsAt: true, status: true, mode: true } },
} as const;
type CallRow = Prisma.CallGetPayload<{ select: typeof callSelect }>;

export interface CallDto {
  id: string;
  kind: 'CHANNEL' | 'CONSULTATION';
  channelId: string | null;
  slotId: string | null;
  messageId: string | null;
  startedById: string;
  startedAt: string;
  endedAt: string | null;
  /** Everyone who has joined at least once (from the SFU's webhooks). */
  participants: string[];
}

export interface JoinDto {
  callId: string;
  url: string;
  token: string;
  canPublish: boolean;
  expiresAt: string;
}

const toCallDto = (c: CallRow): CallDto => ({
  id: c.id,
  kind: c.kind,
  channelId: c.channelId,
  slotId: c.slotId,
  messageId: c.messageId,
  startedById: c.startedById,
  startedAt: c.startedAt.toISOString(),
  endedAt: c.endedAt?.toISOString() ?? null,
  participants: c.participants.map((p) => p.userId),
});

const uniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * WebRTC calls on the on-premise LiveKit SFU (Phase 7): calls in channels and the online rooms
 * of consultation slots. The API never touches media. It decides who may enter (PolicyGuard),
 * signs a 5-minute join token, and keeps re-checking everyone who is connected: a person who
 * loses access (removed from the channel, booking cancelled, offboarded) is removed from the room.
 */
@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(PrincipalFactory) private readonly principals: PrincipalFactory,
    @Inject(ChannelScopedResolver) private readonly resolver: ChannelScopedResolver,
    @Inject(MEDIA_SERVER) private readonly media: MediaServer,
  ) {}

  private ensureEnabled() {
    if (!this.media.enabled) throw new ServiceUnavailableException('Calls are not configured');
  }

  // ───────────────────────────── Channel calls ─────────────────────────────

  /** Starts a call in a channel, or returns the one already running there. */
  async start(principal: Principal, channel: Resource): Promise<CallDto> {
    this.ensureEnabled();
    const now = new Date();
    const row = await this.prisma.channel.findFirst({
      where: { id: channel.id!, tenantId: channel.tenantId },
      select: { id: true, messageTtlSeconds: true },
    });
    if (!row) throw new NotFoundException();
    const live = await this.liveInChannel(row.id);
    if (live) return toCallDto(live);

    let call: CallRow;
    try {
      call = await this.prisma.$transaction(async (tx) => {
        // The timeline entry carries no text, so it fits plaintext and encrypted channels alike.
        const message = await tx.message.create({
          data: {
            channelId: row.id,
            senderId: principal.userId,
            scheme: 'NONE',
            expiresAt: row.messageTtlSeconds ? new Date(now.getTime() + row.messageTtlSeconds * 1000) : null,
          },
          select: { id: true },
        });
        return tx.call.create({
          data: {
            tenantId: channel.tenantId,
            kind: 'CHANNEL',
            channelId: row.id,
            messageId: message.id,
            startedById: principal.userId,
            roomName: newRoomName(),
          },
          select: callSelect,
        });
      });
    } catch (e) {
      // Two people pressed "call" at once: the partial unique index keeps one live call.
      if (uniqueViolation(e)) {
        const existing = await this.liveInChannel(row.id);
        if (existing) return toCallDto(existing);
      }
      throw e;
    }

    const message = await this.prisma.message.findUniqueOrThrow({ where: { id: call.messageId! }, select: messageSelect });
    const recipients = await currentRecipients(this.prisma, row.id, now);
    await this.bus.emitToUsers(recipients, 'message.new', toDto(message));
    await this.notifications.dispatch({ id: message.id, channelId: row.id, senderId: principal.userId, isPriority: false }, recipients, now);
    await this.audit.record({
      actorId: principal.userId,
      tenantId: channel.tenantId,
      action: 'call.start',
      resourceType: ResourceType.CALL,
      resourceId: call.id,
      outcome: 'SUCCESS',
      metadata: { channelId: row.id },
    });
    return toCallDto(call);
  }

  async get(resource: Resource): Promise<CallDto> {
    return toCallDto(await this.load(resource));
  }

  /** A join token for a call the PolicyGuard already allowed the caller to join. */
  async join(principal: Principal, resource: Resource): Promise<JoinDto> {
    this.ensureEnabled();
    const call = await this.load(resource);
    if (call.endedAt) throw new ConflictException('The call has ended');
    if (call.slot) this.assertConsultationOpen(call.slot, new Date());
    return this.token(call, principal, resource.memberRole !== MemberRole.READ_ONLY);
  }

  async end(principal: Principal, resource: Resource): Promise<CallDto> {
    const call = await this.load(resource);
    if (call.endedAt) throw new ConflictException('The call has already ended');
    return toCallDto(await this.endRow(call, principal.userId));
  }

  // ───────────────────────────── Consultation rooms ─────────────────────────────

  /** Opens (on first entry) and joins the online room of a consultation slot. */
  async joinConsultation(principal: Principal, slotResource: Resource): Promise<JoinDto> {
    this.ensureEnabled();
    const slot = await this.prisma.consultationSlot.findFirst({
      where: { id: slotResource.id!, tenantId: slotResource.tenantId },
      select: { id: true, hostId: true, startsAt: true, endsAt: true, status: true, mode: true },
    });
    if (!slot) throw new NotFoundException();
    this.assertConsultationOpen(slot, new Date());

    let call = await this.prisma.call.findFirst({ where: { slotId: slot.id, endedAt: null }, select: callSelect });
    if (!call) {
      try {
        call = await this.prisma.call.create({
          data: { tenantId: slotResource.tenantId, kind: 'CONSULTATION', slotId: slot.id, startedById: principal.userId, roomName: newRoomName() },
          select: callSelect,
        });
      } catch (e) {
        if (!uniqueViolation(e)) throw e;
        call = await this.prisma.call.findFirstOrThrow({ where: { slotId: slot.id, endedAt: null }, select: callSelect });
      }
      await this.emitCall(call);
    }
    return this.token(call, principal, true);
  }

  /** Ends the live room of a slot (the slot was cancelled). */
  async endForSlot(slotId: string, byUserId: string | null): Promise<void> {
    const call = await this.prisma.call.findFirst({ where: { slotId, endedAt: null }, select: callSelect });
    if (call) await this.endRow(call, byUserId);
  }

  // ───────────────────────────── SFU webhooks and re-validation ─────────────────────────────

  /** LiveKit webhook. The signature (a JWT over the body's SHA-256) is checked by the SDK. */
  async webhook(rawBody: Buffer | undefined, authorization: string | undefined): Promise<void> {
    if (!this.media.enabled || !rawBody) throw new UnauthorizedException();
    let event;
    try {
      event = await this.media.verifyWebhook(rawBody.toString('utf8'), authorization);
    } catch {
      throw new UnauthorizedException();
    }
    if (!event.room) return;
    const call = await this.prisma.call.findUnique({ where: { roomName: event.room }, select: callSelect });
    if (!call || call.endedAt) return;

    if (event.event === 'room_finished') {
      await this.endRow(call, null);
      return;
    }
    if (event.event !== 'participant_joined' || !event.identity) return;
    // Defence in depth: a token can only be issued to allowed people, but check again on entry.
    if (!(await this.mayStay(call, event.identity))) {
      await this.media.removeParticipant(call.roomName, event.identity).catch(() => undefined);
      return;
    }
    const now = new Date();
    await this.prisma.callParticipant.upsert({
      where: { callId_userId: { callId: call.id, userId: event.identity } },
      create: { callId: call.id, userId: event.identity, firstJoinedAt: now, lastJoinedAt: now },
      update: { lastJoinedAt: now },
    });
    await this.emitCall(call);
  }

  /**
   * Background job (every minute, like WebSocket session re-validation): everyone connected to a
   * live room must still be allowed to join it; consultation rooms close after the slot; channel
   * calls nobody is in are ended.
   */
  async revalidate(now = new Date()): Promise<{ removed: number; ended: number }> {
    let removed = 0;
    let ended = 0;
    const live = await this.prisma.call.findMany({ where: { endedAt: null }, select: callSelect, take: 500 });
    for (const call of live) {
      if (call.slot && (call.slot.status !== 'ACTIVE' || now.getTime() > call.slot.endsAt.getTime() + CONSULTATION_GRACE_MS)) {
        await this.endRow(call, null);
        ended++;
        continue;
      }
      let identities: string[];
      try {
        identities = await this.media.participants(call.roomName);
      } catch (err) {
        this.logger.warn(`SFU unreachable while re-validating call ${call.id}: ${(err as Error).message}`);
        continue;
      }
      if (!call.slot && identities.length === 0 && now.getTime() - call.startedAt.getTime() > ABANDONED_MS) {
        await this.endRow(call, null);
        ended++;
        continue;
      }
      for (const identity of identities) {
        if (await this.mayStay(call, identity, now)) continue;
        await this.media.removeParticipant(call.roomName, identity).catch(() => undefined);
        removed++;
      }
    }
    return { removed, ended };
  }

  /** Same decision as the PolicyGuard makes for a join token, from current data. */
  private async mayStay(call: CallRow, identity: string, now = new Date()): Promise<boolean> {
    if (!UUID_RE.test(identity)) return false;
    // MFA was proven when the token was issued; here we re-check account, membership and booking.
    const built = await this.principals.build(identity, { mfaVerified: true });
    if (!built) return false;
    const resource = await this.resolver.resolve(ResourceType.CALL, call.id, built.principal);
    if (!resource) return false;
    return (await this.policy.evaluate(built.principal, Action.CALL_JOIN, resource, { now })).allowed;
  }

  // ───────────────────────────── Helpers ─────────────────────────────

  private assertConsultationOpen(
    slot: { startsAt: Date; endsAt: Date; status: string; mode: string },
    now: Date,
  ) {
    if (slot.status !== 'ACTIVE') throw new ConflictException('The consultation was cancelled');
    if (slot.mode !== 'ONLINE') throw new ConflictException('This consultation is in person');
    const t = now.getTime();
    if (t < slot.startsAt.getTime() - CONSULTATION_EARLY_MS || t > slot.endsAt.getTime() + CONSULTATION_GRACE_MS) {
      throw new ConflictException('The consultation room is not open now');
    }
  }

  private async token(call: CallRow, principal: Principal, canPublish: boolean): Promise<JoinDto> {
    const token = await this.media.joinToken({
      room: call.roomName,
      identity: principal.userId,
      canPublish,
      ttlSeconds: JOIN_TOKEN_TTL_SECONDS,
    });
    return {
      callId: call.id,
      url: this.media.publicUrl,
      token,
      canPublish,
      expiresAt: new Date(Date.now() + JOIN_TOKEN_TTL_SECONDS * 1000).toISOString(),
    };
  }

  private async load(resource: Resource): Promise<CallRow> {
    const call = await this.prisma.call.findFirst({ where: { id: resource.id!, tenantId: resource.tenantId }, select: callSelect });
    if (!call) throw new NotFoundException();
    return call;
  }

  private liveInChannel(channelId: string) {
    return this.prisma.call.findFirst({ where: { channelId, endedAt: null }, select: callSelect });
  }

  private async endRow(call: CallRow, byUserId: string | null): Promise<CallRow> {
    const { count } = await this.prisma.call.updateMany({
      where: { id: call.id, endedAt: null },
      data: { endedAt: new Date(), endedById: byUserId },
    });
    const fresh = await this.prisma.call.findUniqueOrThrow({ where: { id: call.id }, select: callSelect });
    if (count === 0) return fresh;
    // Disconnects everyone still in the room.
    await this.media.closeRoom(call.roomName).catch((err: Error) => this.logger.warn(`Could not close room of call ${call.id}: ${err.message}`));
    await this.emitCall(fresh);
    return fresh;
  }

  /** `call.updated` (ids only) to the people who can see the call right now. */
  private async emitCall(call: CallRow) {
    let recipients: string[];
    if (call.channelId) {
      recipients = await currentRecipients(this.prisma, call.channelId);
    } else {
      const booked = await this.prisma.consultationBooking.findMany({
        where: { slotId: call.slotId!, status: 'BOOKED' },
        select: { studentId: true },
      });
      recipients = [call.slot!.hostId, ...booked.map((b) => b.studentId)];
    }
    await this.bus.emitToUsers(recipients, 'call.updated', {
      callId: call.id,
      channelId: call.channelId,
      messageId: call.messageId,
      slotId: call.slotId,
    });
  }
}

/** Random room name: nothing about the channel or the people in it. */
function newRoomName(): string {
  return `pulse-${randomBytes(16).toString('hex')}`;
}
