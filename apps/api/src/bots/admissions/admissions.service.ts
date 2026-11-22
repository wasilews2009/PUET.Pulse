import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@puet/database';
import type { Principal } from '@puet/policy-engine';
import { BotCode } from '@puet/shared';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { PrismaService } from '../../prisma/prisma.service';
import { BotInboxService } from '../bot-inbox.service';
import type { admissionsUploadInput } from '../bots.schemas';
import { ANSWER_GENERATOR, type AnswerGenerator, type Excerpt } from './answer-generator';
import { chunkRules, toPrefixQuery } from './chunker';
import { RATE_LIMITER, type RateLimiter } from './rate-limiter';

/** Questions and answers are personal data of applicants: they disappear after 30 days. */
export const QA_RETENTION_MS = 30 * 24 * 3_600_000;
const TOP_K = 5;

const docDto = (d: { id: string; title: string; sourceSha256: string; active: boolean; chunkCount: number; createdAt: Date }) => ({
  id: d.id,
  title: d.title,
  sha256: d.sourceSha256,
  active: d.active,
  chunks: d.chunkCount,
  createdAt: d.createdAt.toISOString(),
});

/**
 * «AI-консультант приймальної комісії». Retrieval runs in PostgreSQL full-text search over the
 * active version of the admission rules; the answer is either quoted from the rules (default,
 * on-premise) or phrased by Claude from the same excerpts (opt-in).
 */
@Injectable()
export class AdmissionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BotInboxService) private readonly inbox: BotInboxService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ANSWER_GENERATOR) private readonly generator: AnswerGenerator,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  async upload(principal: Principal, input: z.infer<typeof admissionsUploadInput>) {
    const chunks = chunkRules(input.text);
    if (chunks.length === 0) throw new BadRequestException('The document has no text');
    const sha = createHash('sha256').update(input.text, 'utf8').digest('hex');
    const doc = await this.prisma.$transaction(async (tx) => {
      if (input.activate) await tx.admissionsDocument.updateMany({ where: { tenantId: principal.tenantId, active: true }, data: { active: false } });
      const d = await tx.admissionsDocument.create({
        data: { tenantId: principal.tenantId, title: input.title, sourceSha256: sha, active: input.activate, chunkCount: chunks.length, uploadedById: principal.userId },
      });
      await tx.admissionsChunk.createMany({ data: chunks.map((c) => ({ documentId: d.id, ordinal: c.ordinal, heading: c.heading, text: c.text })) });
      return d;
    });
    await this.audit.record({
      actorId: principal.userId,
      tenantId: principal.tenantId,
      action: 'admissions.kb.upload',
      resourceType: 'bot',
      resourceId: doc.id,
      outcome: 'SUCCESS',
      metadata: { sha256: sha, chunks: chunks.length, active: input.activate },
    });
    return docDto(doc);
  }

  async list(principal: Principal) {
    const rows = await this.prisma.admissionsDocument.findMany({ where: { tenantId: principal.tenantId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map(docDto);
  }

  async activate(principal: Principal, documentId: string) {
    const doc = await this.prisma.admissionsDocument.findFirst({ where: { id: documentId, tenantId: principal.tenantId } });
    if (!doc) throw new ForbiddenException('Access denied');
    if (!doc.active) {
      await this.prisma.$transaction([
        this.prisma.admissionsDocument.updateMany({ where: { tenantId: principal.tenantId, active: true }, data: { active: false } }),
        this.prisma.admissionsDocument.update({ where: { id: doc.id }, data: { active: true } }),
      ]);
      await this.audit.record({ actorId: principal.userId, tenantId: principal.tenantId, action: 'admissions.kb.activate', resourceType: 'bot', resourceId: doc.id, outcome: 'SUCCESS' });
    }
    return docDto({ ...doc, active: true });
  }

  /** Best matching excerpts of the tenant's active rules. */
  async retrieve(tenantId: string, question: string): Promise<(Excerpt & { ordinal: number })[]> {
    const q = toPrefixQuery(question);
    if (!q) return [];
    const rows = await this.prisma.$queryRaw<{ ordinal: number; heading: string | null; text: string }[]>(Prisma.sql`
      SELECT c.ordinal, c.heading, c.text
        FROM admissions_chunks c
        JOIN admissions_documents d ON d.id = c.document_id,
             to_tsquery('simple', ${q}) q
       WHERE d.tenant_id = ${tenantId}::uuid
         AND d.active
         AND to_tsvector('simple', coalesce(c.heading, '') || ' ' || c.text) @@ q
       ORDER BY ts_rank_cd(to_tsvector('simple', coalesce(c.heading, '') || ' ' || c.text), q) DESC, c.ordinal
       LIMIT ${TOP_K}`);
    return rows.map((r, i) => ({ n: i + 1, ordinal: r.ordinal, heading: r.heading, text: r.text }));
  }

  async ask(principal: Principal, question: string) {
    const allowed = await this.limiter.hit(`admissions:${principal.userId}`, this.config.bots.admissions.ratePerHour, 3_600_000);
    if (!allowed) throw new HttpException('Too many questions, try again later', HttpStatus.TOO_MANY_REQUESTS);
    const lang = /\p{Script=Cyrillic}/u.test(question) || !/\p{Script=Latin}/u.test(question) ? 'uk' : 'en';
    const excerpts = await this.retrieve(principal.tenantId, question);
    const answer = await this.generator.answer(question, excerpts, lang);
    const expiresAt = new Date(Date.now() + QA_RETENTION_MS);
    const sources = answer.used.flatMap((n) => {
      const e = excerpts.find((x) => x.n === n);
      return e ? [{ ordinal: e.ordinal, heading: e.heading }] : [];
    });
    const [questionId] = await this.inbox.post(principal.tenantId, [principal.userId], BotCode.ADMISSIONS, { direction: 'USER', body: question, expiresAt });
    const [answerId] = await this.inbox.post(principal.tenantId, [principal.userId], BotCode.ADMISSIONS, {
      body: answer.body,
      card: { kind: 'answer', mode: answer.mode, sources },
      expiresAt,
    });
    return { questionId, answerId, mode: answer.mode, body: answer.body, sources };
  }
}
