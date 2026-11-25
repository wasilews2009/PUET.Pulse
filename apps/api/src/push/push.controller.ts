import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { Action, ResourceType } from '@puet/shared';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/principal';
import { Authorize } from '../authz/authorize.decorator';
import { parse } from '../common/validation';
import { sessionIdOf } from '../session/session.store';
import { PushService } from './push.service';

const SELF = { type: ResourceType.SELF } as const;
const endpoint = z.string().url().max(1024).startsWith('https://');
const subscriptionInput = z
  .object({
    endpoint,
    keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/) }).strict(),
    expirationTime: z.number().nullable().optional(),
  })
  .strict();
const unsubscribeInput = z.object({ endpoint }).strict();

/** Phone notifications (Web Push): this browser / installed app subscribes for the signed-in person. */
@Controller('push')
export class PushController {
  constructor(@Inject(PushService) private readonly push: PushService) {}

  @Get('config')
  @Authorize(Action.DEVICE_MANAGE, SELF)
  config() {
    return this.push.publicConfig();
  }

  @Post('subscriptions')
  @HttpCode(200)
  @Authorize(Action.DEVICE_MANAGE, SELF)
  subscribe(@Req() req: AuthenticatedRequest & { sessionToken?: string }, @Body() body: unknown) {
    const input = parse(subscriptionInput, body);
    if (!req.sessionToken) throw new BadRequestException('A browser session is required');
    return this.push.subscribe(req.principal!, sessionIdOf(req.sessionToken), input);
  }

  @Delete('subscriptions')
  @HttpCode(204)
  @Authorize(Action.DEVICE_MANAGE, SELF)
  async unsubscribe(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    await this.push.unsubscribe(req.principal!, parse(unsubscribeInput, body).endpoint);
  }
}
