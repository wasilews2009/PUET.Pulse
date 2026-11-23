import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { Action, ResourceType } from '@puet/shared';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/principal';
import { Authorize } from '../authz/authorize.decorator';
import { parse } from '../common/validation';
import { ApprovalsService, createRouteInput, decisionInput } from './approvals.service';

const FILE = { type: ResourceType.FILE, idField: 'fileId' } as const;
const uuid = z.string().uuid();

@Controller()
export class ApprovalsController {
  constructor(@Inject(ApprovalsService) private readonly approvals: ApprovalsService) {}

  @Get('me/approvals')
  @Authorize(Action.CHANNEL_LIST, { type: ResourceType.SELF })
  inbox(@Req() req: AuthenticatedRequest) {
    return this.approvals.inbox(req.principal!);
  }

  @Post('files/:fileId/approval-routes')
  @Authorize(Action.APPROVAL_ROUTE_CREATE, FILE)
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.approvals.create(req.principal!, req.authz!.resource, parse(createRouteInput, body));
  }

  @Get('files/:fileId/approval-routes')
  @Authorize(Action.FILE_VIEW, FILE)
  list(@Req() req: AuthenticatedRequest) {
    return this.approvals.list(req.authz!.resource);
  }

  @Post('files/:fileId/approval-routes/:routeId/steps/:stepId/decision')
  @Authorize(Action.DOCUMENT_APPROVE, FILE)
  decide(@Req() req: AuthenticatedRequest, @Param('routeId') routeId: string, @Param('stepId') stepId: string, @Body() body: unknown) {
    return this.approvals.decide(req.principal!, req.authz!.resource, parse(uuid, routeId), parse(uuid, stepId), parse(decisionInput, body));
  }

  @Post('files/:fileId/approval-routes/:routeId/cancel')
  @Authorize(Action.APPROVAL_ROUTE_CREATE, FILE)
  cancel(@Req() req: AuthenticatedRequest, @Param('routeId') routeId: string) {
    return this.approvals.cancel(req.principal!, req.authz!.resource, parse(uuid, routeId));
  }
}
