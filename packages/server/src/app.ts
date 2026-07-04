import Fastify from 'fastify';
import type { Logger } from 'pino';
import type { HealthResponse } from '@tsumiwiki/shared';
import type { AppConfig } from './config';
import type { AppDatabase } from './db';
import { authPlugin } from './plugins/auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDocRoutes } from './routes/docs.js';
import { registerDraftRoutes } from './routes/drafts.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerLockRoutes } from './routes/locks.js';
import { registerTrashRoutes } from './routes/trash.js';
import { registerUserRoutes } from './routes/users.js';
import { DocService } from './services/doc-service.js';
import { DraftService } from './services/draft-service.js';
import { GitService } from './services/git-service.js';
import { IndexerService } from './services/indexer-service.js';
import { LockService } from './services/lock-service.js';

export interface BuildAppOptions {
  config: AppConfig;
  db: AppDatabase;
  logger?: Logger | false;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    db: AppDatabase;
    gitService: GitService;
    indexerService: IndexerService;
    docService: DocService;
    lockService: LockService;
    draftService: DraftService;
  }
}

export function buildApp(options: BuildAppOptions) {
  const { config, db, logger } = options;
  // loggerInstance未指定時はログ無効(Fastifyの既定)
  const app = Fastify({ loggerInstance: logger === false ? undefined : logger });

  app.decorate('config', config);
  app.decorate('db', db);

  const gitService = new GitService(config.libraryPath);
  const indexerService = new IndexerService(db, config.libraryPath);
  const lockService = new LockService(db, config.lockTimeoutMinutes);
  const draftService = new DraftService(db);
  const docService = new DocService(
    db,
    config,
    gitService,
    indexerService,
    lockService,
    draftService,
    logger === false ? undefined : logger,
  );
  app.decorate('gitService', gitService);
  app.decorate('indexerService', indexerService);
  app.decorate('lockService', lockService);
  app.decorate('draftService', draftService);
  app.decorate('docService', docService);

  // ライブラリのGitリポジトリ初期化(未初期化なら git init。設計06章6.1)
  app.addHook('onReady', async () => {
    await gitService.init();
  });

  app.register(authPlugin);
  app.register(async (instance) => {
    registerAuthRoutes(instance);
    registerUserRoutes(instance);
    registerDocRoutes(instance);
    registerLockRoutes(instance);
    registerDraftRoutes(instance);
    registerHistoryRoutes(instance);
    registerTrashRoutes(instance);
  });

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
