import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { Action, ResourceType } from '@puet/shared';
import type { AuthenticatedRequest } from '../auth/principal';
import { Authorize } from '../authz/authorize.decorator';
import { parse } from '../common/validation';
import { bookInput, createSlotsInput } from './consultations.schemas';
import { ConsultationsService } from './consultations.service';

const SELF = { type: ResourceType.SELF } as const;
const SLOT = { type: ResourceType.CONSULTATION, idField: 'slotId' } as const;
const USER = { type: ResourceType.USER, idField: 'userId' } as const;

/** «Графік консультацій»: slots of teaching staff and bookings of students (Phase 7). */
@Controller()
export class ConsultationsController {
  constructor(@Inject(ConsultationsService) private readonly consultations: ConsultationsService) {}

  @Get('consultations/mine')
  @Authorize(Action.CONSULTATION_BOOK, SELF)
  mine(@Req() req: AuthenticatedRequest) {
    return this.consultations.mine(req.principal!);
  }

  @Get('consultations/hosts')
  @Authorize(Action.CONSULTATION_BOOK, SELF)
  hosts(@Req() req: AuthenticatedRequest) {
    return this.consultations.myHosts(req.principal!);
  }

  @Get('consultations/courses')
  @Authorize(Action.CONSULTATION_HOST, SELF)
  courses(@Req() req: AuthenticatedRequest) {
    return this.consultations.myCourses(req.principal!);
  }

  @Post('consultations/slots')
  @Authorize(Action.CONSULTATION_HOST, SELF)
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.consultations.createSlots(req.principal!, parse(createSlotsInput, body));
  }

  @Get('users/:userId/consultations')
  @Authorize(Action.USER_PROFILE_READ, USER)
  forHost(@Req() req: AuthenticatedRequest) {
    return this.consultations.forHost(req.principal!, req.authz!.resource);
  }

  @Post('consultations/slots/:slotId/bookings')
  @Authorize(Action.CONSULTATION_BOOK, SLOT)
  book(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.consultations.book(req.principal!, req.authz!.resource, parse(bookInput, body ?? {}));
  }

  @Delete('consultations/slots/:slotId/booking')
  @Authorize(Action.CONSULTATION_BOOK, SLOT)
  cancelBooking(@Req() req: AuthenticatedRequest) {
    return this.consultations.cancelBooking(req.principal!, req.authz!.resource);
  }

  @Post('consultations/slots/:slotId/cancel')
  @HttpCode(200)
  @Authorize(Action.CONSULTATION_MANAGE, SLOT)
  cancel(@Req() req: AuthenticatedRequest) {
    return this.consultations.cancelSlot(req.principal!, req.authz!.resource);
  }
}
