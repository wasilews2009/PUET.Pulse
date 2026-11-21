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
import { ChannelScopedResolver, TenantResourceResolver, UserTargetResolver } from './authz/prisma-resolvers';
import { RESOURCE_RESOLVERS } from './authz/resource-resolver';
import { ChannelsController } from './channels/channels.controller';
import { APP_CONFIG, loadConfig, type AppConfig } from './config/config';
import { HealthController } from './health/health.controller';
import { IntegrationAuthMiddleware } from './integrations/integration-auth.middleware';
import { IntegrationsController } from './integrations/integrations.controller';
import { SyncService } from './integrations/sync.service';
import { POLICY_STORE, PolicyService, PrismaPolicyStore } from './policy/policy.service';
import { PrismaService } from './prisma/prisma.service';
import { SessionAuthService } from './session/session-auth.service';
import { SessionMiddleware } from './session/session.middleware';
import { RedisSessionStore, SESSION_STORE } from './session/session.store';

export const REDIS = Symbol('REDIS');

@Module({
  controllers: [HealthController, AuthController, ChannelsController, IntegrationsController, AdminController],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => new Redis(cfg.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 }),
    },
    { provide: SESSION_STORE, inject: [REDIS], useFactory: (redis: Redis) => new RedisSessionStore(redis) },
    { provide: OIDC_PROVIDER, useClass: OpenIdClientProvider },
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
    {
      provide: RESOURCE_RESOLVERS,
      useFactory: (...resolvers: unknown[]) => resolvers,
      inject: [ChannelScopedResolver, UserTargetResolver, TenantResourceResolver],
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
