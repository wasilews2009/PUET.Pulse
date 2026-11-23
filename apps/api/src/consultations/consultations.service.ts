import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@puet/database';
import type { Principal, Resource } from '@puet/policy-engine';
import { Action, ResourceType } from '@puet/shared';
import { loadTargetFacts } from '../authz/prisma-resolvers';
import { CallsService } from '../calls/calls.service';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime.bus';
import type { BookInput, CreateSlotsInput } from './consultations.schemas';

const WEEK_MS = 7 * 86_400_000;
/** Past slots stay visible for a day (to see what happened), then drop off the lists. */
const KEEP_PAST_MS = 86_400_000;
/** How far ahead a lecturer's schedule is shown to others. */
const SHOW_AHEAD_MS = 60 * 86_400_000;

const slotSelect = {
  id: true,
  tenantId: true,
  hostId: true,
  startsAt: true,
  endsAt: true,
  capacity: true,
  mode: true,
  location: true,
  courseOfferingId: true,
  note: true,
  status: true,
  courseOffering: { select: { discipline: { select: { nameUk: true, nameEn: true } } } },
  bookings: {
    where: { status: 'BOOKED' as const },
    select: { id: true, studentId: true, topic: true, createdAt: true },
    orderBy: { createdAt: 'asc' as const },
  },
  calls: { where: { endedAt: null }, select: { id: true } },
} as const;
type SlotRow = Prisma.ConsultationSlotGetPayload<{ select: typeof slotSelect }>;

export interface BookingDto {
  id: string;
  studentId: string;
  topic: string | null;
  createdAt: string;
}

export interface SlotDto {
  id: string;
  hostId: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  booked: number;
  mode: 'ONLINE' | 'OFFLINE';
  location: string | null;
  courseOfferingId: string | null;
  course: { nameUk: string; nameEn: string } | null;
  note: string | null;
  status: 'ACTIVE' | 'CANCELLED';
  /** The caller's own live booking of this slot. */
  myBooking: BookingDto | null;
  /** Host only: who booked and why. */
  bookings: BookingDto[] | null;
  /** Whether the caller may book it now (policy + free seat + not started). */
  bookable: boolean;
  /** Live online room, if open. */
  callId: string | null;
}

const bookingDto = (b: SlotRow['bookings'][number]): BookingDto => ({
  id: b.id,
  studentId: b.studentId,
  topic: b.topic,
  createdAt: b.createdAt.toISOString(),
});

function guardrail(e: unknown, text: string): boolean {
  return e instanceof Error && e.message.includes(text);
}

/**
 * «Графік консультацій» (Phase 7). Lecturers publish slots (online or in person, optionally
 * for one course); students book a seat with an optional topic. Who may book whom follows the
 * DM rules (policy engine); seats, times and "only cancel, never edit" are enforced by triggers.
 */
@Injectable()
export class ConsultationsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(CallsService) private readonly calls: CallsService,
  ) {}

  /** Course offerings the caller teaches this semester (for "only for this course"). */
  async myCourses(principal: Principal) {
    const rows = await this.prisma.courseOffering.findMany({
      where: { id: { in: principal.activeCourseOfferingIds }, tenantId: principal.tenantId, lecturers: { some: { staffProfile: { userId: principal.userId } } } },
      select: { id: true, discipline: { select: { nameUk: true, nameEn: true } } },
      orderBy: { discipline: { nameUk: 'asc' } },
    });
    return rows.map((r) => ({ id: r.id, nameUk: r.discipline.nameUk, nameEn: r.discipline.nameEn }));
  }

  /**
   * The lecturers of the caller's courses this semester, with how many upcoming slots each has:
   * the starting point for booking. Each row passes the same directory check as a profile view.
   */
  async myHosts(principal: Principal, now = new Date()) {
    const offerings = await this.prisma.courseOffering.findMany({
      where: { id: { in: principal.activeCourseOfferingIds }, tenantId: principal.tenantId },
      select: { discipline: { select: { nameUk: true, nameEn: true } }, lecturers: { select: { staffProfile: { select: { userId: true } } } } },
    });
    const courses = new Map<string, { nameUk: string; nameEn: string }[]>();
    for (const o of offerings) {
      for (const l of o.lecturers) {
        const id = l.staffProfile.userId;
        if (id === principal.userId) continue;
        courses.set(id, [...(courses.get(id) ?? []), o.discipline]);
      }
    }
    const out = [];
    for (const [userId, list] of courses) {
      const target = await loadTargetFacts(this.prisma, userId);
      if (!target) continue;
      const resource: Resource = { type: ResourceType.USER, id: userId, tenantId: target.tenantId, target };
      if (!(await this.policy.evaluate(principal, Action.USER_PROFILE_READ, resource, { now })).allowed) continue;
      const upcoming = await this.prisma.consultationSlot.count({
        where: { hostId: userId, tenantId: target.tenantId, status: 'ACTIVE', startsAt: { gt: now, lt: new Date(now.getTime() + SHOW_AHEAD_MS) } },
      });
      out.push({ userId, courses: list, upcoming });
    }
    return out;
  }

  async createSlots(principal: Principal, input: CreateSlotsInput): Promise<SlotDto[]> {
    if (input.courseOfferingId && !(await this.myCourses(principal)).some((c) => c.id === input.courseOfferingId)) {
      // Only a course the host teaches this semester (same answer as for an unknown id).
      throw new BadRequestException('Unknown course');
    }
    const first = new Date(input.startsAt).getTime();
    const durationMs = input.durationMinutes * 60_000;
    const times = Array.from({ length: input.repeatWeeks }, (_, i) => ({
      startsAt: new Date(first + i * WEEK_MS),
      endsAt: new Date(first + i * WEEK_MS + durationMs),
    }));
    const overlap = await this.prisma.consultationSlot.count({
      where: {
        hostId: principal.userId,
        status: 'ACTIVE',
        OR: times.map((t) => ({ startsAt: { lt: t.endsAt }, endsAt: { gt: t.startsAt } })),
      },
    });
    if (overlap > 0) throw new ConflictException('Overlaps another consultation');

    const ids = await this.prisma.$transaction(
      times.map((t) =>
        this.prisma.consultationSlot.create({
          data: {
            tenantId: principal.tenantId,
            hostId: principal.userId,
            startsAt: t.startsAt,
            endsAt: t.endsAt,
            capacity: input.capacity,
            mode: input.mode,
            location: input.location ?? null,
            courseOfferingId: input.courseOfferingId ?? null,
            note: input.note ?? null,
          },
          select: { id: true },
        }),
      ),
    );
    const rows = await this.prisma.consultationSlot.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      select: slotSelect,
      orderBy: { startsAt: 'asc' },
    });
    return rows.map((r) => this.view(principal, r, false));
  }

  /** The caller's own schedule: slots they host and slots they booked. */
  async mine(principal: Principal, now = new Date()) {
    const since = new Date(now.getTime() - KEEP_PAST_MS);
    const [hosting, booked] = await Promise.all([
      this.prisma.consultationSlot.findMany({
        where: { hostId: principal.userId, tenantId: principal.tenantId, endsAt: { gt: since } },
        select: slotSelect,
        orderBy: { startsAt: 'asc' },
        take: 200,
      }),
      this.prisma.consultationSlot.findMany({
        where: { endsAt: { gt: since }, bookings: { some: { studentId: principal.userId, status: 'BOOKED' } } },
        select: slotSelect,
        orderBy: { startsAt: 'asc' },
        take: 200,
      }),
    ]);
    return {
      hosting: hosting.map((r) => this.view(principal, r, false)),
      booked: booked.map((r) => this.view(principal, r, false)),
    };
  }

  /** A lecturer's upcoming schedule, as the caller sees it (the guard checked the profile is visible). */
  async forHost(principal: Principal, host: Resource, now = new Date()): Promise<SlotDto[]> {
    const target = host.target!;
    const rows = await this.prisma.consultationSlot.findMany({
      where: {
        hostId: target.userId,
        tenantId: target.tenantId,
        status: 'ACTIVE',
        endsAt: { gt: now },
        startsAt: { lt: new Date(now.getTime() + SHOW_AHEAD_MS) },
      },
      select: slotSelect,
      orderBy: { startsAt: 'asc' },
      take: 100,
    });
    const out: SlotDto[] = [];
    for (const r of rows) {
      const resource: Resource = {
        type: ResourceType.CONSULTATION,
        id: r.id,
        tenantId: r.tenantId,
        ownerId: r.hostId,
        target,
        ...(r.bookings.some((b) => b.studentId === principal.userId) ? { isBooked: true } : {}),
        ...(r.courseOfferingId ? { courseOfferingId: r.courseOfferingId } : {}),
      };
      const decision = await this.policy.evaluate(principal, Action.CONSULTATION_BOOK, resource, { now });
      out.push(this.view(principal, r, decision.allowed, now));
    }
    return out;
  }

  async book(principal: Principal, slot: Resource, input: BookInput): Promise<SlotDto> {
    const row = await this.load(slot);
    if (row.status !== 'ACTIVE' || row.startsAt <= new Date()) throw new ConflictException('Booking is closed');
    try {
      await this.prisma.consultationBooking.create({
        data: { slotId: row.id, studentId: principal.userId, topic: input.topic ?? null },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Already booked');
      if (guardrail(e, 'consultation_bookings: slot is full')) throw new ConflictException('The consultation is full');
      if (guardrail(e, 'consultation_bookings: slot is closed')) throw new ConflictException('Booking is closed');
      throw e;
    }
    await this.notify(row.hostId, row.id);
    return this.view(principal, await this.load(slot), false);
  }

  async cancelBooking(principal: Principal, slot: Resource): Promise<SlotDto> {
    const row = await this.load(slot);
    const { count } = await this.prisma.consultationBooking.updateMany({
      where: { slotId: row.id, studentId: principal.userId, status: 'BOOKED' },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    if (count === 0) throw new NotFoundException();
    await this.notify(row.hostId, row.id);
    return this.view(principal, await this.load(slot), false);
  }

  async cancelSlot(principal: Principal, slot: Resource): Promise<SlotDto> {
    const row = await this.load(slot);
    if (row.status !== 'ACTIVE') throw new ConflictException('Already cancelled');
    await this.prisma.consultationSlot.update({ where: { id: row.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await this.calls.endForSlot(row.id, principal.userId);
    await this.notify(row.hostId, row.id, row.bookings.map((b) => b.studentId));
    return this.view(principal, await this.load(slot), false);
  }

  private async load(slot: Resource): Promise<SlotRow> {
    const row = await this.prisma.consultationSlot.findFirst({ where: { id: slot.id!, tenantId: slot.tenantId }, select: slotSelect });
    if (!row) throw new NotFoundException();
    return row;
  }

  /** `consultation.updated` (ids only) to the host and the booked students. */
  private async notify(hostId: string, slotId: string, extra: string[] = []) {
    const booked = await this.prisma.consultationBooking.findMany({ where: { slotId, status: 'BOOKED' }, select: { studentId: true } });
    await this.bus.emitToUsers([hostId, ...booked.map((b) => b.studentId), ...extra], 'consultation.updated', { slotId });
  }

  private view(principal: Principal, r: SlotRow, bookable: boolean, now = new Date()): SlotDto {
    const isHost = r.hostId === principal.userId;
    const mine = r.bookings.find((b) => b.studentId === principal.userId);
    const free = r.bookings.length < r.capacity;
    return {
      id: r.id,
      hostId: r.hostId,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      capacity: r.capacity,
      booked: r.bookings.length,
      mode: r.mode,
      location: r.location,
      courseOfferingId: r.courseOfferingId,
      course: r.courseOffering ? { nameUk: r.courseOffering.discipline.nameUk, nameEn: r.courseOffering.discipline.nameEn } : null,
      note: r.note,
      status: r.status,
      myBooking: mine ? bookingDto(mine) : null,
      bookings: isHost ? r.bookings.map(bookingDto) : null,
      bookable: bookable && !mine && free && r.status === 'ACTIVE' && r.startsAt > now,
      callId: isHost || mine ? (r.calls[0]?.id ?? null) : null,
    };
  }
}
