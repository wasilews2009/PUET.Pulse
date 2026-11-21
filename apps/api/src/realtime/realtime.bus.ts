import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';

export const REALTIME_BUS = Symbol('REALTIME_BUS');

/** Something every API instance must apply to the sockets it holds. */
export type BusEnvelope =
  | { kind: 'emit'; userIds: string[]; event: string; payload: unknown }
  /** Offboarding / logout everywhere: close every socket of these users at once. */
  | { kind: 'disconnect'; userIds: string[] };

/**
 * Fan-out between API instances. Events are addressed to users, never to
 * channel rooms: the sender resolves current members from the database for
 * every event, so a removed member stops receiving immediately (zero trust).
 */
export interface RealtimeBus {
  emitToUsers(userIds: readonly string[], event: string, payload: unknown): Promise<void>;
  disconnectUsers(userIds: readonly string[]): Promise<void>;
  subscribe(handler: (envelope: BusEnvelope) => void): void;
  close(): Promise<void>;
}

const CHANNEL = 'puet:realtime';
/** Keep each published frame small; large fan-outs are split. */
const BATCH = 500;

function batches(ids: readonly string[]): string[][] {
  const unique = [...new Set(ids)];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += BATCH) out.push(unique.slice(i, i + BATCH));
  return out;
}

/** Single-process bus for tests and local development. */
export class MemoryRealtimeBus implements RealtimeBus {
  private readonly handlers: ((e: BusEnvelope) => void)[] = [];
  readonly sent: BusEnvelope[] = [];

  async emitToUsers(userIds: readonly string[], event: string, payload: unknown) {
    for (const ids of batches(userIds)) this.dispatch({ kind: 'emit', userIds: ids, event, payload });
  }

  async disconnectUsers(userIds: readonly string[]) {
    for (const ids of batches(userIds)) this.dispatch({ kind: 'disconnect', userIds: ids });
  }

  subscribe(handler: (envelope: BusEnvelope) => void) {
    this.handlers.push(handler);
  }

  async close() {}

  private dispatch(e: BusEnvelope) {
    this.sent.push(e);
    for (const h of this.handlers) h(e);
  }
}

/** Redis pub/sub bus: every API instance receives every envelope and serves its own sockets. */
export class RedisRealtimeBus implements RealtimeBus {
  private readonly logger = new Logger(RedisRealtimeBus.name);
  private readonly sub: Redis;
  private readonly handlers: ((e: BusEnvelope) => void)[] = [];

  constructor(private readonly pub: Redis) {
    this.sub = pub.duplicate();
    void this.sub.subscribe(CHANNEL);
    this.sub.on('message', (_ch: string, raw: string) => {
      let envelope: BusEnvelope;
      try {
        envelope = JSON.parse(raw) as BusEnvelope;
      } catch {
        this.logger.warn('Dropped a malformed realtime envelope');
        return;
      }
      for (const h of this.handlers) h(envelope);
    });
  }

  async emitToUsers(userIds: readonly string[], event: string, payload: unknown) {
    for (const ids of batches(userIds)) {
      await this.pub.publish(CHANNEL, JSON.stringify({ kind: 'emit', userIds: ids, event, payload }));
    }
  }

  async disconnectUsers(userIds: readonly string[]) {
    for (const ids of batches(userIds)) await this.pub.publish(CHANNEL, JSON.stringify({ kind: 'disconnect', userIds: ids }));
  }

  subscribe(handler: (envelope: BusEnvelope) => void) {
    this.handlers.push(handler);
  }

  async close() {
    await this.sub.quit().catch(() => undefined);
  }
}
