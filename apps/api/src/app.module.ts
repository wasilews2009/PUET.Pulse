import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import Redis from 'ioredis';
import { AdminController } from './admin/admin.controller';
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
    E2eeController,
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
    {
      provide: RESOURCE_RESOLVERS,
      useFactory: (...resolvers: unknown[]) => resolvers,
      inject: [ChannelScopedResolver, UserTargetResolver, TenantResourceResolver, SelfResolver, DeviceResolver],
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
    // Everything else: session cookie + CSRF origin check.
    consumer
      .apply(SessionMiddleware)
      .exclude({ path: 'integrations/*path', method: RequestMethod.ALL })
      .forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
