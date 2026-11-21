import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditService } from './audit/audit.service';
import { AuthenticationGuard } from './auth/authentication.guard';
import { PrincipalFactory } from './auth/principal.factory';
import { PolicyGuard } from './authz/policy.guard';
import {
  ChannelScopedResolver,
  TenantResourceResolver,
  UserTargetResolver,
} from './authz/prisma-resolvers';
import { RESOURCE_RESOLVERS } from './authz/resource-resolver';
import { ChannelsController } from './channels/channels.controller';
import { HealthController } from './health/health.controller';
import { POLICY_STORE, PolicyService, PrismaPolicyStore } from './policy/policy.service';
import { PrismaService } from './prisma/prisma.service';

@Module({
  controllers: [HealthController, ChannelsController],
  providers: [
    PrismaService,
    AuditService,
    PrincipalFactory,
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
export class AppModule {}
