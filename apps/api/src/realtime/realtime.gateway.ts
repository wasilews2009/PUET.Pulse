import { TrustIntakeService } from '../trust/trust-intake.service';
import { Inject, Logger, OnModuleDestroy, UseGuards } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Action, ResourceType } from '@puet/shared';
import type { Server, Socket } from 'socket.io';
import { AuthenticationGuard } from '../auth/authentication.guard';
import type { RequestAuthContext } from '../auth/principal';
import { Authorize } from '../authz/authorize.decorator';
import { PolicyGuard } from '../authz/policy.guard';
import { parse } from '../common/validation';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { sendMessageInput } from '../messaging/messaging.schemas';
import { MessagingService } from '../messaging/messaging.service';
import { SessionAuthService } from '../session/session-auth.service';
import { REALTIME_BUS, type BusEnvelope, type RealtimeBus } from './realtime.bus';

const CHANNEL = { type: ResourceType.CHANNEL, idField: 'channelId' } as const;
/** Sessions are re-validated this often, so revoked or expired sessions lose their socket. */
const REVALIDATE_MS = 60_000;

type SocketData = RequestAuthContext & { sessionToken?: string };
type PulseSocket = Socket<Record<string, never>, Record<string, never>, Record<string, never>, SocketData>;

const userRoom = (userId: string) => `u:${userId}`;

/**
 * Real-time transport (Socket.io on /ws).
 *
 *  - Handshake: the Origin must be the web origin (cross-site WebSocket hijacking),
 *    and the session cookie is resolved exactly like an HTTP request.
 *  - Every event goes through AuthenticationGuard + PolicyGuard with @Authorize. Nest does
 *    not apply APP_GUARD guards to gateways, so they are bound here explicitly;
 *    ids come from the event payload and are resolved server-side.
 *  - Sockets join only their own user room. Channel events are addressed to the
 *    current members, so nobody can subscribe to a channel by id.
 */
@WebSocketGateway({ path: '/ws', serveClient: false, transports: ['websocket'] })
@UseGuards(AuthenticationGuard, PolicyGuard)
export class RealtimeGateway implements OnGatewayInit<Server>, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private server?: Server;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(SessionAuthService) private readonly sessions: SessionAuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
    @Inject(MessagingService) private readonly messaging: MessagingService,
    @Inject(TrustIntakeService) private readonly trust: TrustIntakeService,
  ) {}

  afterInit(server: Server) {
    this.server = server;
    server.use(async (socket: PulseSocket, next) => {
      try {
        if (socket.handshake.headers.origin !== this.config.webOrigin) return next(new Error('Access denied'));
        const token = this.sessions.tokenFromCookieHeader(socket.handshake.headers.cookie);
        const resolved = await this.sessions.resolve(token);
        if (!resolved) return next(new Error('Unauthorized'));
        socket.data.principal = resolved.principal;
        socket.data.sessionToken = resolved.token;
        await socket.join(userRoom(resolved.principal.userId));
        // Events of the person's anonymous appeals reach the same socket; the pseudonym ids never leave the server here.
        const pseudonyms = await this.trust.pseudonymsOf(resolved.principal.userId);
        if (pseudonyms.length) await socket.join(pseudonyms.map(userRoom));
        next();
      } catch (err) {
        this.logger.error('WebSocket handshake failed', err as Error);
        next(new Error('Unauthorized'));
      }
    });

    this.bus.subscribe((e) => this.apply(e));
    this.timer = setInterval(() => void this.revalidate(), REVALIDATE_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  @SubscribeMessage('message.send')
  @Authorize(Action.MESSAGE_SEND, CHANNEL)
  async send(@ConnectedSocket() socket: PulseSocket, @MessageBody() body: unknown) {
    const { channelId: _c, ...payload } = (body ?? {}) as Record<string, unknown>;
    return this.messaging.send(socket.data.principal!, socket.data.authz!.resource, parse(sendMessageInput, payload));
  }

  @SubscribeMessage('channel.read')
  @Authorize(Action.MESSAGE_READ, CHANNEL)
  async read(@ConnectedSocket() socket: PulseSocket) {
    return this.messaging.markRead(socket.data.principal!, socket.data.authz!.resource.id!);
  }

  @SubscribeMessage('typing')
  @Authorize(Action.MESSAGE_SEND, CHANNEL)
  async typing(@ConnectedSocket() socket: PulseSocket) {
    await this.messaging.typing(socket.data.principal!, socket.data.authz!.resource.id!);
    return { ok: true };
  }

  private apply(e: BusEnvelope) {
    const server = this.server;
    if (!server) return;
    if (e.kind === 'emit') {
      server.to(e.userIds.map(userRoom)).emit(e.event, e.payload);
    } else {
      for (const id of e.userIds) server.in(userRoom(id)).disconnectSockets(true);
    }
  }

  /** Drops sockets whose session expired, was logged out or revoked by offboarding. */
  private async revalidate() {
    const server = this.server;
    if (!server) return;
    for (const socket of server.of('/').sockets.values() as IterableIterator<PulseSocket>) {
      try {
        const resolved = await this.sessions.resolve(socket.data.sessionToken);
        if (!resolved) socket.disconnect(true);
        else socket.data.principal = resolved.principal;
      } catch (err) {
        this.logger.warn(`Session re-validation failed: ${(err as Error).message}`);
      }
    }
  }
}
