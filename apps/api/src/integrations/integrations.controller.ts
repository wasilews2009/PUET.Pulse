import { BadRequestException, Body, Controller, ForbiddenException, HttpCode, Inject, Logger, Post, Req } from '@nestjs/common';
import type { IntegrationKind, Prisma } from '@puet/database';
import { Action, ResourceType } from '@puet/shared';
import type { ZodType, ZodTypeDef } from 'zod';
import { Authorize } from '../authz/authorize.decorator';
import { parse } from '../common/validation';
import { PrismaService } from '../prisma/prisma.service';
import { ProvisioningService } from '../provisioning/provisioning.service';
import { IDEMPOTENCY_HEADER } from './hmac';
import type { IntegrationRequest } from './integration-auth.middleware';
import { ChancelleryService } from '../bots/chancellery.service';
import { DeaneryService } from '../bots/deanery.service';
import { ScheduleService } from '../bots/schedule.service';
import { deaneryBatch, edoBatch, scheduleBatch } from '../bots/bots.schemas';
import { offboarding, staffBatch, studentBatch, teachingLoad } from './schemas';
import { SyncService, type SyncResult } from './sync.service';

const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const AUTHZ = { type: ResourceType.INTEGRATION } as const;

/**
 * Webhooks for ЄДЕБО (students), HR (staff), ERP (teaching load) and offboarding.
 * Each call: HMAC-signed, bound to one tenant, requires an Idempotency-Key; a
 * repeated key returns the stored result instead of applying the batch twice.
 * Phase 8 adds the bot feeds: deanery (certificates, ІНП), schedule changes and ЕДО registration.
 */
@Controller('integrations')
export class IntegrationsController {
  constructor(
    @Inject(SyncService) private readonly sync: SyncService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProvisioningService) private readonly provisioning: ProvisioningService,
    @Inject(DeaneryService) private readonly deanery: DeaneryService,
    @Inject(ScheduleService) private readonly schedule: ScheduleService,
    @Inject(ChancelleryService) private readonly chancellery: ChancelleryService,
  ) {}

  @Post('edebo/students')
  @HttpCode(200)
  @Authorize(Action.SYNC_INGEST, AUTHZ)
  students(@Req() req: IntegrationRequest, @Body() body: unknown) {
    return this.run(req, 'EDEBO_STUDENTS', studentBatch, body, (tenantId, b, actor) =>
      this.sync.syncStudents(tenantId, b.records, actor),
    );
  }

  @Post('hr/staff')
  @HttpCode(200)
  @Authorize(Action.SYNC_INGEST, AUTHZ)
  staff(@Req() req: IntegrationRequest, @Body() body: unknown) {
    return this.run(req, 'HR_STAFF', staffBatch, body, (tenantId, b, actor) =>
      this.sync.syncStaff(tenantId, b.records, actor),
    );
  }

  @Post('teaching-load')
  @HttpCode(200)
  @Authorize(Action.SYNC_INGEST, AUTHZ)
  load(@Req() req: IntegrationRequest, @Body() body: unknown) {
    return this.run(req, 'TEACHING_LOAD', teachingLoad, body, (tenantId, b, actor) =>
      this.sync.syncTeachingLoad(tenantId, b, actor),
    );
  }

  @Post('offboarding')
  @HttpCode(200)
  @Authorize(Action.SYNC_INGEST, AUTHZ)
  offboard(@Req() req: IntegrationRequest, @Body() body: unknown) {
    return this.run(req, 'OFFBOARDING', offboarding, body, (tenantId, b, actor) =>
      this.sync.processOffboarding(tenantId, b, actor),
    );
  }

  @Post('deanery')
  @HttpCode(200)
  @Authorize(Action.SYNC_INGEST, AUTHZ)
  deaneryFeed(@Req() req: IntegrationRequest, @Body() body: unknown) {
    return this.run(req, 'DEANERY', deaneryBatch, body, (tenantId, b) => this.deanery.ingest(tenantId, b), false);
  }

  @Post('schedule')
  @HttpCode(200)
  @Authorize(Action.SYNC_INGEST, AUTHZ)
  scheduleFeed(@Req() req: IntegrationRequest, @Body() body: unknown) {
    return this.run(req, 'SCHEDULE', scheduleBatch, body, (tenantId, b) => this.schedule.ingest(tenantId, b), false);
  }

  @Post('edo')
  @HttpCode(200)
  @Authorize(Action.SYNC_INGEST, AUTHZ)
  edoFeed(@Req() req: IntegrationRequest, @Body() body: unknown) {
    return this.run(req, 'EDO', edoBatch, body, (tenantId, b) => this.chancellery.ingest(tenantId, b), false);
  }

  private async run<T>(
    req: IntegrationRequest,
    kind: IntegrationKind,
    schema: ZodType<T, ZodTypeDef, unknown>,
    body: unknown,
    apply: (tenantId: string, batch: T, actorId: string) => Promise<SyncResult>,
    reconcile = true,
  ) {
    const client = req.integrationClient!;
    if (!client.kinds.includes(kind)) throw new ForbiddenException('Access denied');
    const key = req.headers[IDEMPOTENCY_HEADER];
    if (typeof key !== 'string' || !IDEMPOTENCY_RE.test(key)) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    const id = `${client.clientId}:${key}`;
    const previous = await this.prisma.integrationEvent.findUnique({ where: { id } });
    if (previous) return { replayed: true, ...(previous.summary as object) };

    const batch = parse(schema, body);
    const tenantId = req.authz!.resource.tenantId;
    const result = await apply(tenantId, batch, client.id);
    await this.prisma.integrationEvent.create({
      data: {
        id,
        clientId: client.clientId,
        tenantId,
        kind,
        status: result.errors.length === 0 ? 'PROCESSED' : 'FAILED',
        summary: result as unknown as Prisma.InputJsonValue,
      },
    });
    if (!reconcile) return { replayed: false, ...result };
    // Channels and memberships follow the directory right away.
    let channels: unknown = null;
    try {
      channels = await this.provisioning.reconcileTenant(tenantId, client.id);
    } catch (err) {
      new Logger(IntegrationsController.name).error('Channel provisioning failed after sync', err as Error);
    }
    return { replayed: false, ...result, channels };
  }
}
