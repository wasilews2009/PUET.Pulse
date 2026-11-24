import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import Redis from 'ioredis';
import Anthropic from '@anthropic-ai/sdk';
import { AdmissionsService } from './bots/admissions/admissions.service';
import { ANSWER_GENERATOR, ClaudeAnswerGenerator, ExtractiveAnswerGenerator } from './bots/admissions/answer-generator';
import { RATE_LIMITER, RedisRateLimiter } from './bots/admissions/rate-limiter';
import { BotInboxService } from './bots/bot-inbox.service';
import { BotsController } from './bots/bots.controller';
import { ChancelleryService } from './bots/chancellery.service';
import { DeaneryService } from './bots/deanery.service';
import { OUTBOX_SENDER, OutboxService, fetchSender } from './bots/outbox.service';
import { ScheduleService } from './bots/schedule.service';
import { ServiceDeskService } from './bots/service-desk.service';
import { AdminController } from './admin/admin.controller';
import { ApprovalsController } from './approvals/approvals.controller';
import { ApprovalsService } from './approvals/approvals.service';
import { CallsController } from './calls/calls.controller';
import { CallsService } from './calls/calls.service';
import { DisabledMediaServer, LiveKitMediaServer, MEDIA_SERVER } from './calls/media-server';
import { ConsultationsController } from './consultations/consultations.controller';
import { ConsultationsService } from './consultations/consultations.service';
import { PollsController } from './polls/polls.controller';
import { PollsService } from './polls/polls.service';
import { AnnotationsService } from './files/annotations';
import { FilesController } from './files/files.controller';
import { EncryptedBlobsController, EncryptedBlobsService } from './files/encrypted-blobs';
import { FileForwardService } from './files/file-forward.service';
import { FilesService } from './files/files.service';
import { ClamdScanner, MALWARE_SCANNER } from './files/malware-scanner';
import { OBJECT_STORE, S3ObjectStore } from './files/object-store';
import { PadesService } from './pki/pades.service';
import { PkiController } from './pki/pki.controller';
import { CA_LOADER, PkiService, fileCaLoader, type CaLoader } from './pki/pki.service';
import {
  EXTERNAL_SIGNATURE_PROVIDER,
  ExternalQesAdapter,
  INTERNAL_SIGNATURE_PROVIDER,
  InternalPkiProvider,
} from './pki/signature-provider';
import { SignaturesService } from './pki/signatures.service';
import { VerificationService } from './pki/verification.service';
import { PoliciesService } from './admin/policies.service';
import { RolesService } from './admin/roles.service';
import { StructureService } from './admin/structure.service';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthenticationGuard } from './auth/authentication.guard';
import { OIDC_PROVIDER, OpenIdClientProvider } from './auth/oidc.service';
import { PrincipalFactory } from './auth/principal.factory';
import { PolicyGuard } from './authz/policy.guard';
import {
  BotResolver,
  ChannelScopedResolver,
  ConsultationResolver,
  DeviceResolver,
  SelfResolver,
  StudentDocumentResolver,
  TenantResourceResolver,
  TicketResolver,
  UserTargetResolver,
} from './authz/prisma-resolvers';
import { RESOURCE_RESOLVERS } from './authz/resource-resolver';
import { ChannelsController } from './channels/channels.controller';
import { APP_CONFIG, loadConfig, type AppConfig } from './config/config';
import { E2eeController } from './e2ee/e2ee.controller';
import { E2eeService } from './e2ee/e2ee.service';
import { HealthController } from './health/health.controller';
import { IntegrationAuthMiddleware } from './integrations/integration-auth.middleware';
import { IntegrationsController } from './integrations/integrations.controller';
import { SyncService } from './integrations/sync.service';
import { MessagingController } from './messaging/messaging.controller';
import { MessagingService } from './messaging/messaging.service';
import { ProfileController } from './messaging/profile.controller';
import { DirectoryController } from './directory/directory.controller';
import { DIGEST_STORE, RedisDigestStore } from './notifications/digest.store';
import { NotificationService } from './notifications/notification.service';
import { POLICY_STORE, PolicyService, PrismaPolicyStore } from './policy/policy.service';
import { JobsService } from './provisioning/jobs.service';
import { ProvisioningService } from './provisioning/provisioning.service';
import { REALTIME_BUS, RedisRealtimeBus } from './realtime/realtime.bus';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { PrismaService } from './prisma/prisma.service';
import { TrustController } from './trust/trust.controller';
import { TrustIntakeService } from './trust/trust-intake.service';
import { SessionAuthService } from './session/session-auth.service';
import { SessionMiddleware } from './session/session.middleware';
import { RedisSessionStore, SESSION_STORE } from './session/session.store';

import { PRESENCE_TRACKER, RedisPresenceTracker } from './realtime/presence.tracker';

export const REDIS = Symbol('REDIS');

@Module({
  controllers: [
    HealthController,
    AuthController,
    ChannelsController,
    MessagingController,
    ProfileController,
    DirectoryController,
    E2eeController,
    FilesController,
    PkiController,
    ApprovalsController,
    PollsController,
    CallsController,
    ConsultationsController,
    BotsController,
    IntegrationsController,
    AdminController,
    TrustController,
    EncryptedBlobsController,
  ],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => new Redis(cfg.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 }),
    },
    { provide: SESSION_STORE, inject: [REDIS], useFactory: (redis: Redis) => new RedisSessionStore(redis) },
    { provide: OIDC_PROVIDER, useClass: OpenIdClientProvider },
    { provide: REALTIME_BUS, inject: [REDIS], useFactory: (redis: Redis) => new RedisRealtimeBus(redis) },
    { provide: PRESENCE_TRACKER, inject: [REDIS], useFactory: (redis: Redis) => new RedisPresenceTracker(redis) },
    { provide: DIGEST_STORE, inject: [REDIS], useFactory: (redis: Redis) => new RedisDigestStore(redis) },
    {
      provide: OBJECT_STORE,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => new S3ObjectStore({ ...cfg.files.s3, buckets: cfg.files.s3.buckets }),
    },
    { provide: MALWARE_SCANNER, inject: [APP_CONFIG], useFactory: (cfg: AppConfig) => new ClamdScanner(cfg.files.clamav.host, cfg.files.clamav.port) },
    { provide: CA_LOADER, inject: [APP_CONFIG], useFactory: (cfg: AppConfig) => fileCaLoader(cfg) },
    { provide: INTERNAL_SIGNATURE_PROVIDER, inject: [CA_LOADER], useFactory: (ca: CaLoader) => new InternalPkiProvider(ca) },
    { provide: EXTERNAL_SIGNATURE_PROVIDER, inject: [APP_CONFIG], useFactory: (cfg: AppConfig) => new ExternalQesAdapter(cfg.pki.qes) },
    FilesService,
    FileForwardService,
    EncryptedBlobsService,
    AnnotationsService,
    PkiService,
    SignaturesService,
    PadesService,
    ApprovalsService,
    PollsService,
    CallsService,
    ConsultationsService,
    {
      provide: MEDIA_SERVER,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => (cfg.livekit ? new LiveKitMediaServer(cfg.livekit) : new DisabledMediaServer()),
    },
    BotInboxService,
    OutboxService,
    { provide: OUTBOX_SENDER, useValue: fetchSender },
    DeaneryService,
    ScheduleService,
    ServiceDeskService,
    ChancelleryService,
    AdmissionsService,
    { provide: RATE_LIMITER, inject: [REDIS], useFactory: (redis: Redis) => new RedisRateLimiter(redis) },
    {
      provide: ANSWER_GENERATOR,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => {
        const a = cfg.bots.admissions;
        // Opt-in only: the question and the excerpts leave the university's servers.
        return a.answers === 'anthropic' && a.apiKey
          ? new ClaudeAnswerGenerator(new Anthropic({ apiKey: a.apiKey }), a.model)
          : new ExtractiveAnswerGenerator();
      },
    },
    VerificationService,
    MessagingService,
    NotificationService,
    ProvisioningService,
    JobsService,
    E2eeService,
    RealtimeGateway,
    PrismaService,
    TrustIntakeService,
    AuditService,
    PrincipalFactory,
    SessionAuthService,
    AuthService,
    SyncService,
    StructureService,
    RolesService,
    PoliciesService,
    PolicyService,
    { provide: POLICY_STORE, useClass: PrismaPolicyStore },
    ChannelScopedResolver,
    UserTargetResolver,
    TenantResourceResolver,
    SelfResolver,
    DeviceResolver,
    ConsultationResolver,
    BotResolver,
    TicketResolver,
    StudentDocumentResolver,
    {
      provide: RESOURCE_RESOLVERS,
      useFactory: (...resolvers: unknown[]) => resolvers,
      inject: [
        ChannelScopedResolver,
        UserTargetResolver,
        TenantResourceResolver,
        SelfResolver,
        DeviceResolver,
        ConsultationResolver,
        BotResolver,
        TicketResolver,
        StudentDocumentResolver,
      ],
    },
    // Order matters: authenticate first, then authorize. Both apply to every route.
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: PolicyGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Machine-to-machine webhooks: HMAC only, cookies are never read.
    consumer.apply(IntegrationAuthMiddleware).forRoutes({ path: 'integrations/*path', method: RequestMethod.ALL });
    // Everything else: session cookie + CSRF origin check. The SFU's webhook is signed, cookie-less.
    consumer
      .apply(SessionMiddleware)
      .exclude({ path: 'integrations/*path', method: RequestMethod.ALL }, { path: 'calls/livekit/webhook', method: RequestMethod.POST })
      .forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
