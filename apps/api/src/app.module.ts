import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import Redis from 'ioredis';
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
import { FilesService } from './files/files.service';
import { ClamdScanner, MALWARE_SCANNER } from './files/malware-scanner';
import { OBJECT_STORE, S3ObjectStore } from './files/object-store';
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
  ChannelScopedResolver,
  ConsultationResolver,
  DeviceResolver,
  SelfResolver,
  TenantResourceResolver,
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
import { SessionAuthService } from './session/session-auth.service';
import { SessionMiddleware } from './session/session.middleware';
import { RedisSessionStore, SESSION_STORE } from './session/session.store';

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
    IntegrationsController,
    AdminController,
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
    AnnotationsService,
    PkiService,
    SignaturesService,
    ApprovalsService,
    PollsService,
    CallsService,
    ConsultationsService,
    {
      provide: MEDIA_SERVER,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => (cfg.livekit ? new LiveKitMediaServer(cfg.livekit) : new DisabledMediaServer()),
    },
    VerificationService,
    MessagingService,
    NotificationService,
    ProvisioningService,
    JobsService,
    E2eeService,
    RealtimeGateway,
    PrismaService,
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
    {
      provide: RESOURCE_RESOLVERS,
      useFactory: (...resolvers: unknown[]) => resolvers,
      inject: [ChannelScopedResolver, UserTargetResolver, TenantResourceResolver, SelfResolver, DeviceResolver, ConsultationResolver],
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
