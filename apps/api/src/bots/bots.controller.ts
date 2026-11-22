import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { Action, ResourceType, type BotCode } from '@puet/shared';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/principal';
import { Authorize } from '../authz/authorize.decorator';
import { parse } from '../common/validation';
import { AdmissionsService } from './admissions/admissions.service';
import { BOT_SLUG_RE } from './bot-codes';
import { BotInboxService } from './bot-inbox.service';
import {
  admissionsUploadInput,
  askInput,
  createTicketInput,
  orderDocumentInput,
  ticketCommentInput,
  ticketHandleInput,
  ticketRequesterInput,
} from './bots.schemas';
import { DeaneryService } from './deanery.service';
import { ScheduleService } from './schedule.service';
import { ServiceDeskService } from './service-desk.service';

const SELF = { type: ResourceType.SELF } as const;
const BOT = { type: ResourceType.BOT, idField: 'bot', idPattern: BOT_SLUG_RE } as const;
const ADMISSIONS = { type: ResourceType.BOT, idField: 'bot', idPattern: /^admissions$/ } as const;
const TICKET = { type: ResourceType.TICKET, idField: 'ticketId' } as const;
const DOCUMENT = { type: ResourceType.STUDENT_DOCUMENT, idField: 'requestId' } as const;
const before = z.string().datetime().optional();

/** Corporate bots (Phase 8): inboxes, «ЄДЕБО / Деканат», «Розклад ПУЕТ», service desk, admissions. */
@Controller()
export class BotsController {
  constructor(
    @Inject(BotInboxService) private readonly inbox: BotInboxService,
    @Inject(DeaneryService) private readonly deanery: DeaneryService,
    @Inject(ScheduleService) private readonly schedule: ScheduleService,
    @Inject(ServiceDeskService) private readonly desk: ServiceDeskService,
    @Inject(AdmissionsService) private readonly admissions: AdmissionsService,
  ) {}

  // ── Inboxes ──

  @Get('bots')
  @Authorize(Action.BOT_USE, SELF)
  list(@Req() req: AuthenticatedRequest) {
    return this.inbox.summary(req.principal!);
  }

  @Get('bots/:bot/messages')
  @Authorize(Action.BOT_USE, BOT)
  messages(@Req() req: AuthenticatedRequest, @Query('before') b?: string) {
    return this.inbox.list(req.principal!, req.authz!.resource.botCode as BotCode, parse(before, b));
  }

  @Post('bots/:bot/read')
  @HttpCode(200)
  @Authorize(Action.BOT_USE, BOT)
  read(@Req() req: AuthenticatedRequest) {
    return this.inbox.markRead(req.principal!, req.authz!.resource.botCode as BotCode);
  }

  // ── Admissions consultant ──

  @Post('bots/:bot/ask')
  @HttpCode(200)
  @Authorize(Action.BOT_USE, ADMISSIONS)
  ask(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.admissions.ask(req.principal!, parse(askInput, body).question);
  }

  @Get('bots/:bot/kb')
  @Authorize(Action.ADMISSIONS_KB_MANAGE, ADMISSIONS)
  kb(@Req() req: AuthenticatedRequest) {
    return this.admissions.list(req.principal!);
  }

  @Post('bots/:bot/kb')
  @Authorize(Action.ADMISSIONS_KB_MANAGE, ADMISSIONS)
  upload(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.admissions.upload(req.principal!, parse(admissionsUploadInput, body));
  }

  @Post('bots/:bot/kb/:documentId/activate')
  @HttpCode(200)
  @Authorize(Action.ADMISSIONS_KB_MANAGE, ADMISSIONS)
  activate(@Req() req: AuthenticatedRequest, @Param('documentId', new ParseUUIDPipe()) documentId: string) {
    return this.admissions.activate(req.principal!, documentId);
  }

  // ── ЄДЕБО / Деканат ──

  @Post('deanery/requests')
  @Authorize(Action.DEANERY_USE, SELF)
  order(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.deanery.order(req.principal!, parse(orderDocumentInput, body));
  }

  @Get('deanery/requests')
  @Authorize(Action.DEANERY_USE, SELF)
  myRequests(@Req() req: AuthenticatedRequest) {
    return this.deanery.mine(req.principal!);
  }

  @Post('deanery/requests/:requestId/cancel')
  @HttpCode(200)
  @Authorize(Action.DEANERY_USE, DOCUMENT)
  cancel(@Req() req: AuthenticatedRequest) {
    return this.deanery.cancel(req.principal!, req.authz!.resource);
  }

  @Get('deanery/study-plan')
  @Authorize(Action.DEANERY_USE, SELF)
  studyPlan(@Req() req: AuthenticatedRequest) {
    return this.deanery.studyPlans(req.principal!);
  }

  // ── Розклад ПУЕТ ──

  @Get('schedule/changes')
  @Authorize(Action.SCHEDULE_READ, SELF)
  changes(@Req() req: AuthenticatedRequest) {
    return this.schedule.mine(req.principal!);
  }

  // ── Service desk АГР та ІТ ──

  @Post('service-desk/tickets')
  @Authorize(Action.TICKET_CREATE, SELF)
  createTicket(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.desk.create(req.principal!, parse(createTicketInput, body));
  }

  @Get('service-desk/tickets/mine')
  @Authorize(Action.TICKET_CREATE, SELF)
  myTickets(@Req() req: AuthenticatedRequest) {
    return this.desk.mine(req.principal!);
  }

  @Get('service-desk/queue')
  @Authorize(Action.TICKET_HANDLE, SELF)
  queue(@Req() req: AuthenticatedRequest, @Query('status') status?: string) {
    return this.desk.queue(req.principal!, parse(z.enum(['open', 'closed']).optional(), status));
  }

  @Get('service-desk/tickets/:ticketId')
  @Authorize(Action.TICKET_READ, TICKET)
  ticket(@Req() req: AuthenticatedRequest) {
    return this.desk.get(req.principal!, req.authz!.resource);
  }

  @Post('service-desk/tickets/:ticketId/comments')
  @Authorize(Action.TICKET_UPDATE, TICKET)
  comment(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.desk.comment(req.principal!, req.authz!.resource, parse(ticketCommentInput, body).comment);
  }

  @Post('service-desk/tickets/:ticketId/requester')
  @HttpCode(200)
  @Authorize(Action.TICKET_UPDATE, TICKET)
  requester(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.desk.requesterAction(req.principal!, req.authz!.resource, parse(ticketRequesterInput, body));
  }

  @Post('service-desk/tickets/:ticketId/handle')
  @HttpCode(200)
  @Authorize(Action.TICKET_HANDLE, TICKET)
  handle(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.desk.handle(req.principal!, req.authz!.resource, parse(ticketHandleInput, body));
  }
}
