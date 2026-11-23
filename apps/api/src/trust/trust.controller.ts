import { Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { Action, ResourceType } from '@puet/shared';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/principal';
import { Authorize } from '../authz/authorize.decorator';
import { parse } from '../common/validation';
import { TrustIntakeService } from './trust-intake.service';

const SELF = { type: ResourceType.SELF } as const;
const CHANNEL = { type: ResourceType.CHANNEL, idField: 'channelId' } as const;
const uuid = z.string().uuid();

/** Anonymous appeals to the trust services (Phase 9). */
@Controller()
export class TrustController {
  constructor(@Inject(TrustIntakeService) private readonly intake: TrustIntakeService) {}

  @Get('trust-services')
  @Authorize(Action.TRUST_INTAKE, SELF)
  services(@Req() req: AuthenticatedRequest) {
    return this.intake.services(req.principal!);
  }

  @Post('trust-services/:orgUnitId/appeals')
  @Authorize(Action.TRUST_INTAKE, SELF)
  open(@Req() req: AuthenticatedRequest, @Param('orgUnitId') orgUnitId: string) {
    return this.intake.open(req.principal!, parse(uuid, orgUnitId));
  }

  @Get('me/appeals')
  @Authorize(Action.TRUST_INTAKE, SELF)
  mine(@Req() req: AuthenticatedRequest) {
    return this.intake.mine(req.principal!);
  }

  @Post('me/appeals/:caseId/close')
  @Authorize(Action.TRUST_INTAKE, SELF)
  closeOwn(@Req() req: AuthenticatedRequest, @Param('caseId') caseId: string) {
    return this.intake.closeOwn(req.principal!, parse(uuid, caseId));
  }

  /** An officer closes the appeal of their trust room (channel moderators only). */
  @Post('channels/:channelId/appeal/close')
  @Authorize(Action.CHANNEL_MODERATE, CHANNEL)
  closeByOfficer(@Req() req: AuthenticatedRequest) {
    return this.intake.closeByOfficer(req.principal!, req.authz!.resource);
  }
}
