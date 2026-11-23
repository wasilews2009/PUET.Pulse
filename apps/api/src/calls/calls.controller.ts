import { Controller, Get, Headers, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { Action, ResourceType } from '@puet/shared';
import type { Request } from 'express';
import type { AuthenticatedRequest } from '../auth/principal';
import { Public } from '../auth/public.decorator';
import { Authorize } from '../authz/authorize.decorator';
import { CallsService } from './calls.service';

const CHANNEL = { type: ResourceType.CHANNEL, idField: 'channelId' } as const;
const CALL = { type: ResourceType.CALL, idField: 'callId' } as const;
const SLOT = { type: ResourceType.CONSULTATION, idField: 'slotId' } as const;

/** WebRTC calls in channels and consultation rooms (Phase 7). */
@Controller()
export class CallsController {
  constructor(@Inject(CallsService) private readonly calls: CallsService) {}

  @Post('channels/:channelId/calls')
  @Authorize(Action.CALL_START, CHANNEL)
  start(@Req() req: AuthenticatedRequest) {
    return this.calls.start(req.principal!, req.authz!.resource);
  }

  @Get('calls/:callId')
  @Authorize(Action.MESSAGE_READ, CALL)
  get(@Req() req: AuthenticatedRequest) {
    return this.calls.get(req.authz!.resource);
  }

  @Post('calls/:callId/join')
  @HttpCode(200)
  @Authorize(Action.CALL_JOIN, CALL)
  join(@Req() req: AuthenticatedRequest) {
    return this.calls.join(req.principal!, req.authz!.resource);
  }

  @Post('calls/:callId/end')
  @HttpCode(200)
  @Authorize(Action.CALL_MANAGE, CALL)
  end(@Req() req: AuthenticatedRequest) {
    return this.calls.end(req.principal!, req.authz!.resource);
  }

  @Post('consultations/slots/:slotId/join')
  @HttpCode(200)
  @Authorize(Action.CALL_JOIN, SLOT)
  joinConsultation(@Req() req: AuthenticatedRequest) {
    return this.calls.joinConsultation(req.principal!, req.authz!.resource);
  }

  /** LiveKit → API. Authenticated by the webhook signature only (no session, no cookies). */
  @Public()
  @Post('calls/livekit/webhook')
  @HttpCode(200)
  async webhook(@Req() req: Request & { rawBody?: Buffer }, @Headers('authorization') authorization: string | undefined) {
    await this.calls.webhook(req.rawBody, authorization);
    return { ok: true };
  }
}
