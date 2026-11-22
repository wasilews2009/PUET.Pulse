import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@puet/database';
import type { Principal, Resource } from '@puet/policy-engine';
import { ChannelType, E2eeMode, MemberRole, ResourceType } from '@puet/shared';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../audit/audit-chain';
import { AuditService } from '../audit/audit.service';
import { currentRecipients, toDto, messageSelect } from '../messaging/messaging.service';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime.bus';
import { FORMAL_OPTIONS, type CreatePollInput } from './polls.schemas';
import { protocolPdf, type Lang, type ProtocolData } from './protocol-pdf';

const pollSelect = {
  id: true,
  tenantId: true,
  channelId: true,
  messageId: true,
  createdById: true,
  question: true,
  options: true,
  mode: true,
  multipleChoice: true,
  formal: true,
  quorum: true,
  eligibleCount: true,
  status: true,
  closesAt: true,
  closedAt: true,
  closedById: true,
  result: true,
  createdAt: true,
} as const;
type PollRow = Prisma.PollGetPayload<{ select: typeof pollSelect }>;

interface Result {
  counts: number[];
  participants: number;
}

export interface PollDto {
  id: string;
  channelId: string;
  messageId: string;
  createdById: string;
  question: string;
  options: string[];
  mode: 'OPEN' | 'SECRET';
  multipleChoice: boolean;
  formal: boolean;
  quorum: number | null;
  eligibleCount: number;
  status: 'OPEN' | 'CLOSED';
  closesAt: string | null;
  closedAt: string | null;
  createdAt: string;
  participants: number;
  /** Per-option counts; null while a formal secret ballot is still open. */
  counts: number[] | null;
  /** OPEN mode only: who chose each option. */
  voters: string[][] | null;
  me: { voted: boolean; eligible: boolean; options: number[] | null };
  quorumReached: boolean | null;
  adopted: boolean | null;
}

const isModerator = (r: Resource) => r.memberRole === MemberRole.OWNER || r.memberRole === MemberRole.MODERATOR;
const activeNow = (now: Date) => ({ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

/** Was this error raised by a Phase 6 database guardrail? */
function guardrail(e: unknown, text: string): boolean {
  return e instanceof Error && e.message.includes(text);
}

/**
 * Polls and formal votes (Вчена рада, Ректорат, НМР). The PolicyGuard already decided
 * who may create, vote and close; the database guardrails make the record tamper-proof:
 * votes only while open, one per person, nothing edited afterwards. In SECRET mode only
 * anonymous per-option counters are written, so no row links a voter to a choice.
 */
@Injectable()
export class PollsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(principal: Principal, channel: Resource, input: CreatePollInput): Promise<PollDto> {
    const now = new Date();
    const row = await this.prisma.channel.findFirst({
      where: { id: channel.id!, tenantId: channel.tenantId },
      select: { id: true, type: true, e2eeMode: true, threadsRequired: true, messageTtlSeconds: true },
    });
    if (!row) throw new NotFoundException();
    // The server would see the question and the choices: encrypted rooms get polls with encrypted polls later.
    if (row.e2eeMode !== E2eeMode.DISABLED) throw new BadRequestException('Polls are not available in encrypted channels');
    if (input.formal && row.type !== ChannelType.GOVERNANCE) {
      throw new BadRequestException('Formal votes are held in collegial bodies only');
    }
    if (row.threadsRequired && !isModerator(channel)) throw new ForbiddenException('Reply in a thread');

    const eligible = input.formal
      ? await this.prisma.channelMember.findMany({
          where: { channelId: row.id, role: { not: MemberRole.READ_ONLY }, ...activeNow(now), user: { status: 'ACTIVE' } },
          select: { userId: true },
        })
      : [];
    const eligibleCount = input.formal
      ? eligible.length
      : await this.prisma.channelMember.count({
          where: { channelId: row.id, role: { not: MemberRole.READ_ONLY }, ...activeNow(now), user: { status: 'ACTIVE' } },
        });
    const options = input.formal ? [...FORMAL_OPTIONS] : input.options!;
    let quorum: number | null = null;
    if (input.formal) {
      // Default: more than half of the members entitled to vote.
      quorum = input.quorum ?? Math.floor(eligibleCount / 2) + 1;
      if (quorum > eligibleCount) throw new BadRequestException('Quorum exceeds the number of eligible voters');
    }

    const poll = await this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          channelId: row.id,
          senderId: principal.userId,
          body: input.question,
          scheme: 'NONE',
          expiresAt: row.messageTtlSeconds ? new Date(now.getTime() + row.messageTtlSeconds * 1000) : null,
        },
        select: { id: true },
      });
      const created = await tx.poll.create({
        data: {
          tenantId: channel.tenantId,
          channelId: row.id,
          messageId: message.id,
          createdById: principal.userId,
          question: input.question,
          options,
          mode: input.mode,
          multipleChoice: input.multipleChoice,
          formal: input.formal,
          quorum,
          eligibleCount,
          closesAt: input.closesAt ? new Date(input.closesAt) : null,
        },
        select: pollSelect,
      });
      if (input.mode === 'SECRET') {
        await tx.pollTally.createMany({ data: options.map((_, optionIndex) => ({ pollId: created.id, optionIndex })) });
      }
      if (input.formal) {
        await tx.pollEligible.createMany({ data: eligible.map((e) => ({ pollId: created.id, userId: e.userId })) });
      }
      return created;
    });

    const message = await this.prisma.message.findUniqueOrThrow({ where: { id: poll.messageId }, select: messageSelect });
    const recipients = await currentRecipients(this.prisma, row.id, now);
    await this.bus.emitToUsers(recipients, 'message.new', toDto(message));
    await this.notifications.dispatch({ id: message.id, channelId: row.id, senderId: principal.userId, isPriority: false }, recipients, now);
    if (input.formal) {
      await this.audit.record({
        actorId: principal.userId,
        tenantId: channel.tenantId,
        action: 'poll.formal.open',
        resourceType: ResourceType.VOTE,
        resourceId: poll.id,
        outcome: 'SUCCESS',
        metadata: { channelId: row.id, mode: input.mode, eligible: eligibleCount, quorum },
      });
    }
    return this.view(principal, poll);
  }

  async get(principal: Principal, resource: Resource): Promise<PollDto> {
    let poll = await this.load(resource);
    if (poll.status === 'OPEN' && poll.closesAt && poll.closesAt <= new Date()) poll = await this.closeRow(poll, null);
    return this.view(principal, poll);
  }

  async vote(principal: Principal, resource: Resource, choice: number[]): Promise<PollDto> {
    let poll = await this.load(resource);
    if (poll.status === 'OPEN' && poll.closesAt && poll.closesAt <= new Date()) poll = await this.closeRow(poll, null);
    if (poll.status !== 'OPEN') throw new ConflictException('Voting is closed');
    const options = poll.options as string[];
    if (choice.some((i) => i >= options.length)) throw new BadRequestException('Unknown option');
    if (!poll.multipleChoice && choice.length !== 1) throw new BadRequestException('Choose one option');
    if (poll.formal) {
      const eligible = await this.prisma.pollEligible.findUnique({
        where: { pollId_userId: { pollId: poll.id, userId: principal.userId } },
        select: { userId: true },
      });
      // Joined after the vote opened (or was read-only then): not on the frozen list.
      if (!eligible) throw new ForbiddenException('Access denied');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.pollParticipation.create({ data: { pollId: poll.id, userId: principal.userId } });
        if (poll.mode === 'OPEN') {
          await tx.pollBallot.create({ data: { pollId: poll.id, userId: principal.userId, optionIndexes: choice } });
        } else {
          // Anonymous counters only: no voter id, no timestamp.
          for (const optionIndex of choice) {
            await tx.pollTally.update({
              where: { pollId_optionIndex: { pollId: poll.id, optionIndex } },
              data: { votes: { increment: 1 } },
            });
          }
        }
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Already voted');
      if (guardrail(e, 'polls: voting is closed')) throw new ConflictException('Voting is closed');
      if (guardrail(e, 'polls: not an eligible voter')) throw new ForbiddenException('Access denied');
      throw e;
    }

    if (poll.formal) {
      // The fact of participation is recorded; the choice never is.
      await this.audit.record({
        actorId: principal.userId,
        tenantId: resource.tenantId,
        action: 'poll.vote',
        resourceType: ResourceType.VOTE,
        resourceId: poll.id,
        outcome: 'SUCCESS',
      });
    }
    await this.notify(poll);
    return this.view(principal, poll);
  }

  async close(principal: Principal, resource: Resource): Promise<PollDto> {
    const poll = await this.load(resource);
    if (poll.status !== 'OPEN') throw new ConflictException('Already closed');
    return this.view(principal, await this.closeRow(poll, principal.userId));
  }

  /** Background job: close polls whose deadline passed. */
  async closeDue(now = new Date()): Promise<number> {
    const due = await this.prisma.poll.findMany({
      where: { status: 'OPEN', closesAt: { lte: now } },
      select: pollSelect,
      take: 100,
    });
    for (const p of due) await this.closeRow(p, null);
    return due.length;
  }

  async protocol(resource: Resource, lang: Lang): Promise<Buffer> {
    const poll = await this.load(resource);
    if (!poll.formal) throw new BadRequestException('Only formal votes have a protocol');
    if (poll.status !== 'CLOSED') throw new ConflictException('The vote is still open');
    const result = poll.result as unknown as Result;
    const [channel, creator, closer, participants, ballots] = await Promise.all([
      this.prisma.channel.findUniqueOrThrow({ where: { id: poll.channelId }, select: { nameUk: true, nameEn: true } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: poll.createdById }, select: { fullNameUk: true, fullNameEn: true } }),
      poll.closedById
        ? this.prisma.user.findUnique({ where: { id: poll.closedById }, select: { fullNameUk: true, fullNameEn: true } })
        : null,
      this.prisma.pollParticipation.findMany({
        where: { pollId: poll.id },
        select: { user: { select: { fullNameUk: true, fullNameEn: true } } },
      }),
      poll.mode === 'OPEN'
        ? this.prisma.pollBallot.findMany({
            where: { pollId: poll.id },
            select: { optionIndexes: true, user: { select: { fullNameUk: true, fullNameEn: true } } },
          })
        : [],
    ]);
    const name = (u: { fullNameUk: string; fullNameEn: string | null }) => (lang === 'en' && u.fullNameEn ? u.fullNameEn : u.fullNameUk);
    const quorumReached = result.participants >= (poll.quorum ?? 0);
    const data: ProtocolData = {
      pollId: poll.id,
      body: (lang === 'en' && channel.nameEn) || channel.nameUk || '',
      question: poll.question,
      mode: poll.mode,
      openedAt: poll.createdAt.toISOString(),
      closedAt: poll.closedAt!.toISOString(),
      openedBy: name(creator),
      closedBy: closer ? name(closer) : null,
      eligible: poll.eligibleCount,
      quorum: poll.quorum ?? 0,
      participants: result.participants,
      counts: result.counts,
      quorumReached,
      adopted: quorumReached && (result.counts[0] ?? 0) > result.participants / 2,
      participantNames: participants.map((p) => name(p.user)).sort((a, b) => a.localeCompare(b, 'uk')),
      rollCall:
        poll.mode === 'OPEN'
          ? FORMAL_OPTIONS.map((_, i) =>
              ballots
                .filter((b) => b.optionIndexes.includes(i))
                .map((b) => name(b.user))
                .sort((a, b) => a.localeCompare(b, 'uk')),
            )
          : null,
      // Fingerprint of the frozen result: lets the Academic Secretary match a printout to the record.
      digest: createHash('sha256')
        .update(canonicalJson({ id: poll.id, question: poll.question, mode: poll.mode, quorum: poll.quorum, eligible: poll.eligibleCount, result, closedAt: poll.closedAt!.toISOString() }))
        .digest('hex'),
    };
    return protocolPdf(data, lang);
  }

  // ───────────────────────────── internals ─────────────────────────────

  private async load(resource: Resource): Promise<PollRow> {
    const poll = await this.prisma.poll.findFirst({ where: { id: resource.id!, tenantId: resource.tenantId }, select: pollSelect });
    if (!poll) throw new NotFoundException();
    return poll;
  }

  private async tally(poll: PollRow): Promise<Result> {
    const n = (poll.options as string[]).length;
    const counts = new Array<number>(n).fill(0);
    if (poll.mode === 'OPEN') {
      const ballots = await this.prisma.pollBallot.findMany({ where: { pollId: poll.id }, select: { optionIndexes: true } });
      for (const b of ballots) for (const i of b.optionIndexes) if (i < n) counts[i]! += 1;
    } else {
      const tallies = await this.prisma.pollTally.findMany({ where: { pollId: poll.id }, select: { optionIndex: true, votes: true } });
      for (const t of tallies) if (t.optionIndex < n) counts[t.optionIndex] = t.votes;
    }
    const participants = await this.prisma.pollParticipation.count({ where: { pollId: poll.id } });
    return { counts, participants };
  }

  private async closeRow(poll: PollRow, closedById: string | null): Promise<PollRow> {
    const result = await this.tally(poll);
    let closed: PollRow;
    try {
      // Only an OPEN row moves to CLOSED: a concurrent close loses the race and re-reads.
      const updated = await this.prisma.poll.updateMany({
        where: { id: poll.id, status: 'OPEN' },
        data: { status: 'CLOSED', closedAt: new Date(), closedById, result: result as unknown as Prisma.InputJsonValue },
      });
      closed = await this.prisma.poll.findUniqueOrThrow({ where: { id: poll.id }, select: pollSelect });
      if (updated.count === 0) return closed;
    } catch (e) {
      if (guardrail(e, 'polls: a closed poll is immutable')) {
        return this.prisma.poll.findUniqueOrThrow({ where: { id: poll.id }, select: pollSelect });
      }
      throw e;
    }
    if (poll.formal) {
      await this.audit.record({
        actorId: closedById,
        tenantId: poll.tenantId,
        action: 'poll.formal.close',
        resourceType: ResourceType.VOTE,
        resourceId: poll.id,
        outcome: 'SUCCESS',
        metadata: { participants: result.participants, quorum: poll.quorum, automatic: closedById === null },
      });
    }
    await this.notify(closed);
    return closed;
  }

  private async notify(poll: PollRow) {
    const recipients = await currentRecipients(this.prisma, poll.channelId);
    await this.bus.emitToUsers(recipients, 'poll.updated', { pollId: poll.id, channelId: poll.channelId, messageId: poll.messageId });
  }

  private async view(principal: Principal, poll: PollRow): Promise<PollDto> {
    const closed = poll.status === 'CLOSED';
    const result = closed ? (poll.result as unknown as Result) : await this.tally(poll);
    const [mine, ballot, eligible] = await Promise.all([
      this.prisma.pollParticipation.findUnique({
        where: { pollId_userId: { pollId: poll.id, userId: principal.userId } },
        select: { userId: true },
      }),
      poll.mode === 'OPEN'
        ? this.prisma.pollBallot.findUnique({
            where: { pollId_userId: { pollId: poll.id, userId: principal.userId } },
            select: { optionIndexes: true },
          })
        : null,
      poll.formal
        ? this.prisma.pollEligible.findUnique({
            where: { pollId_userId: { pollId: poll.id, userId: principal.userId } },
            select: { userId: true },
          })
        : Promise.resolve({ userId: principal.userId }),
    ]);
    let voters: string[][] | null = null;
    if (poll.mode === 'OPEN') {
      const ballots = await this.prisma.pollBallot.findMany({ where: { pollId: poll.id }, select: { userId: true, optionIndexes: true } });
      voters = (poll.options as string[]).map((_, i) => ballots.filter((b) => b.optionIndexes.includes(i)).map((b) => b.userId));
    }
    // A secret formal ballot reveals nothing before it closes, not even a running count.
    const hidden = poll.formal && poll.mode === 'SECRET' && !closed;
    const quorumReached = poll.formal ? result.participants >= (poll.quorum ?? 0) : null;
    return {
      id: poll.id,
      channelId: poll.channelId,
      messageId: poll.messageId,
      createdById: poll.createdById,
      question: poll.question,
      options: poll.options as string[],
      mode: poll.mode,
      multipleChoice: poll.multipleChoice,
      formal: poll.formal,
      quorum: poll.quorum,
      eligibleCount: poll.eligibleCount,
      status: poll.status,
      closesAt: poll.closesAt?.toISOString() ?? null,
      closedAt: poll.closedAt?.toISOString() ?? null,
      createdAt: poll.createdAt.toISOString(),
      participants: result.participants,
      counts: hidden ? null : result.counts,
      voters: hidden ? null : voters,
      me: { voted: !!mine, eligible: !!eligible, options: ballot?.optionIndexes ?? null },
      quorumReached,
      adopted: poll.formal && closed ? !!quorumReached && (result.counts[0] ?? 0) > result.participants / 2 : null,
    };
  }
}
