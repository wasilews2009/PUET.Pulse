import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { FilesService } from '../files/files.service';
import { DIGEST_STORE, type DigestStore } from '../notifications/digest.store';
import { PkiService } from '../pki/pki.service';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProvisioningService } from './provisioning.service';

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

/**
 * Background jobs. Several API instances may run; a Redis leader lock per job
 * makes sure each tick runs once.
 *  - release Quiet Hours digests when the window ends;
 *  - hard-delete messages whose self-destruct timer expired;
 *  - archive course channels after the semester;
 *  - retry quarantined files whose scan was deferred (scanner down);
 *  - mark expired certificates.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private readonly owner = randomUUID();
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(ProvisioningService) private readonly provisioning: ProvisioningService,
    @Inject(DIGEST_STORE) private readonly locks: DigestStore,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(PkiService) private readonly pki: PkiService,
  ) {}

  readonly jobs: Job[] = [
    { name: 'digests', everyMs: 30_000, run: () => this.notifications.releaseDueDigests() },
    { name: 'ttl-purge', everyMs: 60_000, run: () => this.purgeExpiredMessages() },
    { name: 'course-archive', everyMs: 600_000, run: () => this.provisioning.archiveEndedCourses() },
    { name: 'file-scan', everyMs: 30_000, run: () => this.files.processPending() },
    { name: 'certificate-expiry', everyMs: 3_600_000, run: () => this.pki.expireCertificates() },
  ];

  onApplicationBootstrap() {
    if (!this.config.jobsEnabled) return;
    for (const job of this.jobs) {
      const t = setInterval(() => void this.tick(job), job.everyMs);
      t.unref();
      this.timers.push(t);
    }
  }

  onModuleDestroy() {
    for (const t of this.timers) clearInterval(t);
  }

  /** Self-destructing messages are erased for good, not tombstoned. */
  async purgeExpiredMessages(now = new Date()): Promise<number> {
    const { count } = await this.prisma.message.deleteMany({ where: { expiresAt: { lte: now } } });
    return count;
  }

  private async tick(job: Job) {
    try {
      if (!(await this.locks.acquireLock(`job:${job.name}`, job.everyMs * 2, this.owner))) return;
      await job.run();
    } catch (err) {
      this.logger.error(`Job ${job.name} failed`, err as Error);
    }
  }
}
