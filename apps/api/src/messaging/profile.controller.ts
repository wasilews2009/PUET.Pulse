import { BadRequestException, Body, Controller, Get, Inject, Put, Req } from '@nestjs/common';
import { Action, ResourceType } from '@puet/shared';
import type { AuthenticatedRequest } from '../auth/principal';
import { Authorize } from '../authz/authorize.decorator';
import { parse } from '../common/validation';
import { isValidTimeZone } from '../notifications/quiet-hours';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_BUS, type RealtimeBus } from '../realtime/realtime.bus';
import { presenceInput, quietHoursInput } from './messaging.schemas';

const DEFAULT_QUIET_HOURS = {
  enabled: false,
  timezone: 'Europe/Kyiv',
  startMinute: 1080,
  endMinute: 510,
  weekdays: [1, 2, 3, 4, 5],
  digestEnabled: true,
};

/** Presence statuses («На парі», «Не турбувати» …) and Quiet Hours of the caller. */
@Controller()
export class ProfileController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
  ) {}

  @Put('me/presence')
  @Authorize(Action.PRESENCE_UPDATE, { type: ResourceType.SELF })
  async setPresence(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(presenceInput, body);
    const until = input.until ? new Date(input.until) : null;
    if (until && until <= new Date()) throw new BadRequestException('until must be in the future');
    const user = await this.prisma.user.update({
      where: { id: req.principal!.userId },
      data: { presence: input.status, presenceUntil: until },
      select: { presence: true, presenceUntil: true },
    });
    const result = { status: user.presence, until: user.presenceUntil?.toISOString() ?? null };
    await this.bus.emitToUsers([req.principal!.userId], 'presence.self', result);
    return result;
  }

  /** Presence of another person: same visibility as their profile (minor protection, guests). */
  @Get('users/:userId/presence')
  @Authorize(Action.USER_PROFILE_READ, { type: ResourceType.USER, idField: 'userId' })
  async getPresence(@Req() req: AuthenticatedRequest) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: req.authz!.resource.id! },
      select: { presence: true, presenceUntil: true },
    });
    const expired = user.presenceUntil !== null && user.presenceUntil <= new Date();
    return { status: expired ? 'ONLINE' : user.presence, until: expired ? null : (user.presenceUntil?.toISOString() ?? null) };
  }

  @Get('me/quiet-hours')
  @Authorize(Action.QUIET_HOURS_MANAGE, { type: ResourceType.SELF })
  async getQuietHours(@Req() req: AuthenticatedRequest) {
    const row = await this.prisma.quietHoursSchedule.findUnique({ where: { userId: req.principal!.userId } });
    if (!row) return DEFAULT_QUIET_HOURS;
    const { id: _id, userId: _u, updatedAt: _t, ...rest } = row;
    return rest;
  }

  @Put('me/quiet-hours')
  @Authorize(Action.QUIET_HOURS_MANAGE, { type: ResourceType.SELF })
  async setQuietHours(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(quietHoursInput, body);
    if (!isValidTimeZone(input.timezone)) throw new BadRequestException('Unknown time zone');
    const data = { ...input, weekdays: [...new Set(input.weekdays)].sort() };
    const row = await this.prisma.quietHoursSchedule.upsert({
      where: { userId: req.principal!.userId },
      create: { userId: req.principal!.userId, ...data },
      update: data,
    });
    const { id: _id, userId: _u, updatedAt: _t, ...rest } = row;
    return rest;
  }
}
