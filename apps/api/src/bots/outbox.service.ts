import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OutboxTarget, Prisma } from '@puet/database';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { IDEMPOTENCY_HEADER, SIGNATURE_HEADER, sign } from '../integrations/hmac';
import { PrismaService } from '../prisma/prisma.service';

const MAX_ATTEMPTS = 20;
const BATCH = 50;
const TIMEOUT_MS = 10_000;

export type OutboxSender = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;

export const OUTBOX_SENDER = Symbol('OUTBOX_SENDER');

/**
 * Signed outbound events to university systems (deanery, ЕДО). Same scheme as the inbound
 * webhooks: `X-PUET-Signature: t=..,v1=HMAC-SHA256(secret, "<t>.<body>")` and an Idempotency-Key
 * equal to the outbox id, so the receiver can drop retries. Payloads carry ids, not names.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OUTBOX_SENDER) private readonly send: OutboxSender,
  ) {}

  async enqueue(tenantId: string, target: OutboxTarget, eventType: string, payload: Record<string, unknown>, tx?: Prisma.TransactionClient) {
    await (tx ?? this.prisma).integrationOutbox.create({
      data: { tenantId, target, eventType, payload: payload as Prisma.InputJsonValue },
    });
  }

  /** One pass over due events. Targets without configuration keep their events pending. */
  async flush(now = new Date()): Promise<{ sent: number; failed: number }> {
    const due = await this.prisma.integrationOutbox.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: now } },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    });
    let sent = 0;
    let failed = 0;
    for (const event of due) {
      const target = this.config.bots.outbox[event.target];
      if (!target) continue;
      const body = JSON.stringify({ id: event.id, type: event.eventType, occurredAt: event.createdAt.toISOString(), data: event.payload });
      let error: string | null = null;
      try {
        const res = await this.send(target.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [SIGNATURE_HEADER]: sign(target.secret, Math.floor(Date.now() / 1000), body),
            [IDEMPOTENCY_HEADER]: event.id,
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status < 200 || res.status >= 300) error = `http.${res.status}`;
      } catch (err) {
        error = (err as Error).name === 'TimeoutError' ? 'timeout' : 'network';
      }
      if (!error) {
        await this.prisma.integrationOutbox.update({ where: { id: event.id }, data: { status: 'SENT', sentAt: new Date(), attempts: event.attempts + 1, lastError: null } });
        sent++;
        continue;
      }
      const attempts = event.attempts + 1;
      const backoffMs = Math.min(2 ** attempts * 30_000, 6 * 3_600_000);
      await this.prisma.integrationOutbox.update({
        where: { id: event.id },
        data: {
          attempts,
          lastError: error,
          ...(attempts >= MAX_ATTEMPTS ? { status: 'FAILED' } : { nextAttemptAt: new Date(now.getTime() + backoffMs) }),
        },
      });
      if (attempts >= MAX_ATTEMPTS) {
        failed++;
        this.logger.error(`Outbox event ${event.id} to ${event.target} failed permanently (${error})`);
      }
    }
    return { sent, failed };
  }
}

export const fetchSender: OutboxSender = async (url, init) => {
  const res = await fetch(url, { ...init, redirect: 'error' });
  return { status: res.status };
};
