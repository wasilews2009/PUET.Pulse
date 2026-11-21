import { Controller, Get, Inject, NotFoundException, Param, Req } from '@nestjs/common';
import { Action, ResourceType } from '@puet/shared';
import type { AuthenticatedRequest } from '../auth/principal';
import { Authorize } from '../authz/authorize.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Reference controller showing the pattern every Phase 2+ endpoint follows:
 * @Authorize names the action and where the id is; the guard has already loaded
 * the resource and checked membership, so the handler only selects safe fields.
 */
@Controller('channels')
export class ChannelsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get(':channelId')
  @Authorize(Action.CHANNEL_READ, { type: ResourceType.CHANNEL, idField: 'channelId' })
  async getChannel(@Param('channelId') channelId: string, @Req() req: AuthenticatedRequest) {
    // Tenant id comes from the authorized resource, so the query stays inside the tenant.
    const tenantId = req.authz!.resource.tenantId;
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, tenantId },
      select: {
        id: true,
        type: true,
        e2eeMode: true,
        nameUk: true,
        nameEn: true,
        topic: true,
        isOfficial: true,
        confidential: true,
        archivedAt: true,
        messageTtlSeconds: true,
      },
    });
    if (!channel) throw new NotFoundException();
    return channel;
  }
}
