import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });

  app.disable('x-powered-by');
  // Only trust X-Forwarded-For from the configured reverse proxies (TLS 1.3 terminator).
  app.set('trust proxy', (process.env.TRUSTED_PROXIES ?? '127.0.0.1').split(',').map((s) => s.trim()));
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    }),
  );
  app.enableShutdownHooks();

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  Logger.log(`PUET.Pulse API listening on :${port}`, 'Bootstrap');
}

void bootstrap();
