import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WsException } from '@nestjs/websockets';
import { AccountStatus } from '@puet/shared';
import type { AuthenticatedRequest, AuthenticatedSocket } from './principal';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * First global guard. Rejects any request that has no server-built principal or
 * whose account is not ACTIVE. The OIDC/SAML session layer (Phase 2) attaches the
 * principal; until then every non-public route answers 401. There is no dev bypass.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const isWs = context.getType() === 'ws';
    const principal = isWs
      ? context.switchToWs().getClient<AuthenticatedSocket>().data?.principal
      : context.switchToHttp().getRequest<AuthenticatedRequest>().principal;

    if (!principal || principal.status !== AccountStatus.ACTIVE) {
      if (isWs) throw new WsException('Unauthorized');
      throw new UnauthorizedException();
    }
    return true;
  }
}
