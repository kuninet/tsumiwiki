import Fastify from 'fastify';
import type { Logger } from 'pino';
import type { HealthResponse } from '@tsumiwiki/shared';
import type { AppConfig } from './config';
import type { AppDatabase } from './db';

export interface BuildAppOptions {
  config: AppConfig;
  db: AppDatabase;
  logger?: Logger | false;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    db: AppDatabase;
  }
}

export function buildApp(options: BuildAppOptions) {
  const { config, db, logger } = options;
  // loggerInstance未指定時はログ無効(Fastifyの既定)
  const app = Fastify({ loggerInstance: logger === false ? undefined : logger });

  app.decorate('config', config);
  app.decorate('db', db);

  app.get('/api/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      name: 'tsumiwiki',
      version: '0.1.0',
      time: new Date().toISOString(),
    };
  });

  return app;
}
