import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Action, ResourceType } from '@puet/shared';
import type { AuthenticatedRequest } from '../auth/principal';
import { Authorize } from '../authz/authorize.decorator';
import { parse } from '../common/validation';
import {
  addMembersInput,
  createGroupInput,
  editMessageInput,
  historyQuery,
  muteInput,
  readInput,
  sendMessageInput,
  updateChannelInput,
} from './messaging.schemas';
import { MessagingService } from './messaging.service';

const CHANNEL = { type: ResourceType.CHANNEL, idField: 'channelId' } as const;
const MESSAGE = { type: ResourceType.MESSAGE, idField: 'messageId' } as const;

/** REST side of messaging. The WebSocket gateway offers the same send/read/typing operations. */
@Controller()
export class MessagingController {
  constructor(@Inject(MessagingService) private readonly messaging: MessagingService) {}

  @Get('me/channels')
  @Authorize(Action.CHANNEL_LIST, { type: ResourceType.SELF })
  myChannels(@Req() req: AuthenticatedRequest) {
    return this.messaging.myChannels(req.principal!);
  }

  @Post('channels')
  @Authorize(Action.CHANNEL_CREATE, { type: ResourceType.SELF })
  createGroup(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.messaging.createGroup(req.principal!, parse(createGroupInput, body));
  }

  @Post('users/:userId/direct')
  @Authorize(Action.DM_START, { type: ResourceType.USER, idField: 'userId' })
  startDirect(@Req() req: AuthenticatedRequest) {
    return this.messaging.startDirect(req.principal!, req.authz!.resource);
  }

  @Patch('channels/:channelId')
  @Authorize(Action.CHANNEL_UPDATE, CHANNEL)
  update(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.messaging.update(req.authz!.resource, parse(updateChannelInput, body));
  }

  @Get('channels/:channelId/members')
  @Authorize(Action.CHANNEL_READ, CHANNEL)
  members(@Req() req: AuthenticatedRequest) {
    return this.messaging.members(req.authz!.resource.id!);
  }

  @Post('channels/:channelId/members')
  @Authorize(Action.CHANNEL_MEMBERS_MANAGE, CHANNEL)
  addMembers(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.messaging.addMembers(req.principal!, req.authz!.resource, parse(addMembersInput, body).userIds);
  }

  @Delete('channels/:channelId/members/me')
  @Authorize(Action.MESSAGE_READ, CHANNEL)
  leave(@Req() req: AuthenticatedRequest) {
    return this.messaging.leave(req.principal!, req.authz!.resource);
  }

  @Delete('channels/:channelId/members/:memberId')
  @Authorize(Action.CHANNEL_MEMBERS_MANAGE, CHANNEL)
  removeMember(@Req() req: AuthenticatedRequest, @Param('memberId') memberId: string) {
    return this.messaging.removeMember(req.principal!, req.authz!.resource, parse(addMembersInput.shape.userIds.element, memberId));
  }

  @Get('channels/:channelId/messages')
  @Authorize(Action.MESSAGE_READ, CHANNEL)
  history(@Req() req: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    const { channelId: _omit, ...rest } = query;
    return this.messaging.history(req.authz!.resource.id!, parse(historyQuery, rest));
  }

  @Post('channels/:channelId/messages')
  @Authorize(Action.MESSAGE_SEND, CHANNEL)
  send(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.messaging.send(req.principal!, req.authz!.resource, parse(sendMessageInput, body));
  }

  @Post('channels/:channelId/read')
  @HttpCode(200)
  @Authorize(Action.MESSAGE_READ, CHANNEL)
  read(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const { messageId } = parse(readInput, body ?? {});
    return this.messaging.markRead(req.principal!, req.authz!.resource.id!, messageId);
  }

  @Put('channels/:channelId/mute')
  @Authorize(Action.MESSAGE_READ, CHANNEL)
  mute(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.messaging.mute(req.principal!, req.authz!.resource.id!, parse(muteInput, body).mutedUntil);
  }

  @Patch('messages/:messageId')
  @Authorize(Action.MESSAGE_EDIT, MESSAGE)
  edit(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.messaging.edit(req.principal!, req.authz!.resource, parse(editMessageInput, body));
  }

  @Delete('messages/:messageId')
  @Authorize(Action.MESSAGE_DELETE, MESSAGE)
  remove(@Req() req: AuthenticatedRequest) {
    return this.messaging.remove(req.principal!, req.authz!.resource);
  }
}
