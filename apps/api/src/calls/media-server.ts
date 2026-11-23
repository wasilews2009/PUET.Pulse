import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver } from 'livekit-server-sdk';

export const MEDIA_SERVER = Symbol('MEDIA_SERVER');

export interface JoinGrant {
  room: string;
  /** LiveKit identity: the user id. Display names are resolved by the client from profile cards. */
  identity: string;
  /** READ_ONLY members listen and watch, they do not publish. */
  canPublish: boolean;
  ttlSeconds: number;
}

export interface MediaWebhookEvent {
  event: string;
  room?: string;
  identity?: string;
}

/**
 * The SFU (LiveKit, on-premise). Media never passes through the API: the API signs short-lived
 * join tokens for people the policy engine allows, and removes participants when that changes.
 * Token signing and webhook verification are done by the official livekit-server-sdk.
 */
export interface MediaServer {
  readonly enabled: boolean;
  /** WebSocket URL the browser connects to (wss://...). */
  readonly publicUrl: string;
  joinToken(grant: JoinGrant): Promise<string>;
  /** Identities connected to a room right now. */
  participants(room: string): Promise<string[]>;
  removeParticipant(room: string, identity: string): Promise<void>;
  closeRoom(room: string): Promise<void>;
  /** Verifies the webhook signature (JWT with the body's SHA-256); throws if it is not valid. */
  verifyWebhook(rawBody: string, authorization: string | undefined): Promise<MediaWebhookEvent>;
}

export interface LiveKitConfig {
  url: string;
  publicUrl: string;
  apiKey: string;
  apiSecret: string;
}

const PUBLISH_SOURCES = [TrackSource.CAMERA, TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];

export class LiveKitMediaServer implements MediaServer {
  readonly enabled = true;
  readonly publicUrl: string;
  private readonly rooms: RoomServiceClient;
  private readonly webhooks: WebhookReceiver;

  constructor(private readonly cfg: LiveKitConfig) {
    this.publicUrl = cfg.publicUrl;
    this.rooms = new RoomServiceClient(cfg.url, cfg.apiKey, cfg.apiSecret);
    this.webhooks = new WebhookReceiver(cfg.apiKey, cfg.apiSecret);
  }

  async joinToken(g: JoinGrant): Promise<string> {
    const at = new AccessToken(this.cfg.apiKey, this.cfg.apiSecret, { identity: g.identity, ttl: g.ttlSeconds });
    at.addGrant({
      roomJoin: true,
      room: g.room,
      canSubscribe: true,
      canPublish: g.canPublish,
      canPublishSources: g.canPublish ? PUBLISH_SOURCES : [],
      // No data channel and no self-set metadata: nothing user-controlled travels beside the media.
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    return at.toJwt();
  }

  async participants(room: string): Promise<string[]> {
    try {
      return (await this.rooms.listParticipants(room)).map((p) => p.identity);
    } catch (e) {
      // LiveKit answers "not found" for a room nobody has joined yet.
      if (e instanceof Error && /not.?found/i.test(e.message)) return [];
      throw e;
    }
  }

  async removeParticipant(room: string, identity: string): Promise<void> {
    await this.rooms.removeParticipant(room, identity);
  }

  async closeRoom(room: string): Promise<void> {
    try {
      await this.rooms.deleteRoom(room);
    } catch (e) {
      if (!(e instanceof Error && /not.?found/i.test(e.message))) throw e;
    }
  }

  async verifyWebhook(rawBody: string, authorization: string | undefined): Promise<MediaWebhookEvent> {
    const ev = await this.webhooks.receive(rawBody, authorization);
    return {
      event: ev.event,
      ...(ev.room?.name ? { room: ev.room.name } : {}),
      ...(ev.participant?.identity ? { identity: ev.participant.identity } : {}),
    };
  }
}

/** LiveKit is not configured: calls are unavailable (the API answers 503). */
export class DisabledMediaServer implements MediaServer {
  readonly enabled = false;
  readonly publicUrl = '';
  private fail(): never {
    throw new Error('Media server is not configured');
  }
  async joinToken(): Promise<string> {
    return this.fail();
  }
  async participants(): Promise<string[]> {
    return [];
  }
  async removeParticipant(): Promise<void> {}
  async closeRoom(): Promise<void> {}
  async verifyWebhook(): Promise<MediaWebhookEvent> {
    return this.fail();
  }
}

/** In-memory SFU for tests: records tokens, lets tests "connect" identities and checks removals. */
export class FakeMediaServer implements MediaServer {
  readonly enabled = true;
  readonly publicUrl = 'wss://sfu.test';
  readonly grants: JoinGrant[] = [];
  readonly connected = new Map<string, Set<string>>();
  readonly removed: { room: string; identity: string }[] = [];
  readonly closed: string[] = [];
  /** Webhook "signature" the fake accepts. */
  webhookSecret = 'fake-webhook-secret';

  async joinToken(g: JoinGrant): Promise<string> {
    this.grants.push(g);
    return `token:${g.room}:${g.identity}:${g.canPublish ? 'pub' : 'sub'}`;
  }
  connect(room: string, identity: string) {
    if (!this.connected.has(room)) this.connected.set(room, new Set());
    this.connected.get(room)!.add(identity);
  }
  async participants(room: string): Promise<string[]> {
    return [...(this.connected.get(room) ?? [])];
  }
  async removeParticipant(room: string, identity: string): Promise<void> {
    this.removed.push({ room, identity });
    this.connected.get(room)?.delete(identity);
  }
  async closeRoom(room: string): Promise<void> {
    this.closed.push(room);
    this.connected.delete(room);
  }
  async verifyWebhook(rawBody: string, authorization: string | undefined): Promise<MediaWebhookEvent> {
    if (authorization !== this.webhookSecret) throw new Error('invalid webhook signature');
    return JSON.parse(rawBody) as MediaWebhookEvent;
  }
}
