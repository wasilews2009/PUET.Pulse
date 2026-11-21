import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { AuthenticationGuard } from '../src/auth/authentication.guard';
import { AUTHORIZE_KEY } from '../src/authz/authorize.decorator';
import { PolicyGuard } from '../src/authz/policy.guard';
import { RealtimeGateway } from '../src/realtime/realtime.gateway';

const MESSAGE_MAPPING = 'websockets:message_mapping';

describe('WebSocket gateway is zero-trust', () => {
  it('binds AuthenticationGuard then PolicyGuard (global APP_GUARDs do not reach gateways)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, RealtimeGateway)).toEqual([AuthenticationGuard, PolicyGuard]);
  });

  it('fail-closed: every subscribed event declares @Authorize', () => {
    const proto = RealtimeGateway.prototype as unknown as Record<string, unknown>;
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (k) => typeof proto[k] === 'function' && Reflect.getMetadata(MESSAGE_MAPPING, proto[k] as object),
    );
    expect(handlers.length).toBeGreaterThanOrEqual(3);
    for (const h of handlers) expect(Reflect.getMetadata(AUTHORIZE_KEY, proto[h] as object), h).toBeDefined();
  });
});
