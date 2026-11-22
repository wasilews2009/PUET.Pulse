import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import { canSeeInDirectory, type Principal } from '@puet/policy-engine';
import { Action, ResourceType } from '@puet/shared';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/principal';
import { Authorize } from '../authz/authorize.decorator';
import { loadTargetFacts } from '../authz/prisma-resolvers';
import { parse } from '../common/validation';
import { PrismaService } from '../prisma/prisma.service';

const searchQuery = z.object({ q: z.string().trim().min(2).max(80) }).strict();
const cardsInput = z.object({ userIds: z.array(z.string().uuid()).min(1).max(100) }).strict();

const cardSelect = {
  id: true,
  kind: true,
  fullNameUk: true,
  fullNameEn: true,
  presence: true,
  presenceUntil: true,
  staffProfile: { select: { position: true, academicDegree: true, academicTitle: true } },
} as const;

type CardRow = {
  id: string;
  kind: string;
  fullNameUk: string;
  fullNameEn: string | null;
  presence: string;
  presenceUntil: Date | null;
  staffProfile: { position: string; academicDegree: string | null; academicTitle: string | null } | null;
};

/** A public card: no phone, e-mail, birth date, dormitory room or corporate id. */
export function toCard(u: CardRow, now = new Date()) {
  const expired = u.presenceUntil !== null && u.presenceUntil <= now;
  return {
    id: u.id,
    kind: u.kind,
    fullNameUk: u.fullNameUk,
    fullNameEn: u.fullNameEn,
    position: u.staffProfile?.position ?? null,
    academicDegree: u.staffProfile?.academicDegree ?? null,
    academicTitle: u.staffProfile?.academicTitle ?? null,
    presence: expired ? 'ONLINE' : u.presence,
  };
}

/**
 * People directory and profile cards. Every row is filtered by
 * canSeeInDirectory() on the server (minor protection, guests, tenants), so a
 * hidden person is simply absent; the client never filters.
 */
@Controller()
export class DirectoryController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('users/:userId')
  @Authorize(Action.USER_PROFILE_READ, { type: ResourceType.USER, idField: 'userId' })
  async profile(@Req() req: AuthenticatedRequest) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: req.authz!.resource.id! }, select: cardSelect });
    return toCard(user);
  }

  /** Personal phone: self and HR only (policy engine, USER_PHONE_READ). */
  @Get('users/:userId/phone')
  @Authorize(Action.USER_PHONE_READ, { type: ResourceType.USER, idField: 'userId' })
  async phone(@Req() req: AuthenticatedRequest) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: req.authz!.resource.id! }, select: { phone: true } });
    return { phone: user.phone };
  }

  @Get('directory')
  @Authorize(Action.DIRECTORY_SEARCH, { type: ResourceType.DIRECTORY })
  async search(@Req() req: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    const { q } = parse(searchQuery, query);
    const principal = req.principal!;
    const rows = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        // Pseudonyms of anonymous appeals are never searchable (their cards are shown only by id).
        kind: { not: 'PSEUDONYM' },
        // Students and guests search their own tenant only; staff also see staff of other tenants.
        ...(principal.kind === 'STAFF' ? {} : { tenantId: principal.tenantId }),
        OR: [{ fullNameUk: { contains: q, mode: 'insensitive' } }, { fullNameEn: { contains: q, mode: 'insensitive' } }],
      },
      orderBy: { fullNameUk: 'asc' },
      take: 60,
      select: cardSelect,
    });
    return (await this.visible(principal, rows)).slice(0, 20).map((u) => toCard(u));
  }

  /** Cards for ids the client already holds (channel members, message senders). Hidden ids are dropped. */
  @Post('directory/cards')
  @HttpCode(200)
  @Authorize(Action.DIRECTORY_SEARCH, { type: ResourceType.DIRECTORY })
  async cards(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const { userIds } = parse(cardsInput, body);
    const rows = await this.prisma.user.findMany({ where: { id: { in: [...new Set(userIds)] } }, select: cardSelect });
    return (await this.visible(req.principal!, rows)).map((u) => toCard(u));
  }

  private async visible<T extends { id: string }>(principal: Principal, rows: T[]): Promise<T[]> {
    if (principal.kind === 'GUEST') return [];
    const out: T[] = [];
    for (const row of rows) {
      const facts = await loadTargetFacts(this.prisma, row.id);
      if (facts && canSeeInDirectory(principal, facts)) out.push(row);
    }
    return out;
  }
}
