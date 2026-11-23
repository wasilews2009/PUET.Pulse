import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { Action, ResourceType } from '@puet/shared';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/principal';
import { Authorize } from '../authz/authorize.decorator';
import { binary } from '../common/binary';
import { parse } from '../common/validation';
import { createPollInput, voteInput } from './polls.schemas';
import { PollsService } from './polls.service';

const CHANNEL = { type: ResourceType.CHANNEL, idField: 'channelId' } as const;
const POLL = { type: ResourceType.VOTE, idField: 'pollId' } as const;

/** Polls in channels and formal votes of collegial bodies (Phase 6). */
@Controller()
export class PollsController {
  constructor(@Inject(PollsService) private readonly polls: PollsService) {}

  @Post('channels/:channelId/polls')
  @Authorize(Action.POLL_CREATE, CHANNEL)
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.polls.create(req.principal!, req.authz!.resource, parse(createPollInput, body));
  }

  @Get('polls/:pollId')
  @Authorize(Action.MESSAGE_READ, POLL)
  get(@Req() req: AuthenticatedRequest) {
    return this.polls.get(req.principal!, req.authz!.resource);
  }

  @Post('polls/:pollId/votes')
  @Authorize(Action.VOTE_CAST, POLL)
  vote(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.polls.vote(req.principal!, req.authz!.resource, parse(voteInput, body).options);
  }

  @Post('polls/:pollId/close')
  @HttpCode(200)
  @Authorize(Action.POLL_MANAGE, POLL)
  close(@Req() req: AuthenticatedRequest) {
    return this.polls.close(req.principal!, req.authz!.resource);
  }

  @Get('polls/:pollId/protocol.pdf')
  @Authorize(Action.MESSAGE_READ, POLL)
  async protocol(@Req() req: AuthenticatedRequest, @Query('lang') lang: string | undefined, @Res() res: Response) {
    const pdf = await this.polls.protocol(req.authz!.resource, lang === 'en' ? 'en' : 'uk');
    res.setHeader('Content-Disposition', 'inline; filename="vote-protocol.pdf"');
    binary(res, 'application/pdf', pdf);
  }
}
