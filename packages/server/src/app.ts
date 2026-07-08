import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { Logger } from 'pino';
import type { HealthResponse } from '@tsumiwiki/shared';
import type { AppConfig } from './config';
import type { AppDatabase } from './db';
import { authPlugin } from './plugins/auth.js';
import { registerAttachmentRoutes } from './routes/attachments.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDocRoutes } from './routes/docs.js';
import { registerDraftRoutes } from './routes/drafts.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerLockRoutes } from './routes/locks.js';
import { registerLibraryRoutes } from './routes/library.js';
import { librarySettingsRoutes } from './routes/library-settings.js';
import { dailyNotesRoutes } from './routes/daily-notes.js';
import { templatesRoutes } from './routes/templates.js';
import { registerQueryRoutes } from './routes/query.js';
import { registerTrashRoutes } from './routes/trash.js';
import { registerUserRoutes } from './routes/users.js';
import { DocService } from './services/doc-service.js';
import { DraftService } from './services/draft-service.js';
import { GitService } from './services/git-service.js';
import { IndexerService } from './services/indexer-service.js';
import { LibrarySettingsService } from './services/library-settings-service.js';
import { LockService } from './services/lock-service.js';
import { QueryService } from './services/query-service.js';
import { SyncService } from './services/sync-service.js';
import { BackupService } from './services/backup-service.js';

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
    queryService: QueryService;
    syncService: SyncService;
    backupService: BackupService;
    librarySettingsService: LibrarySettingsService;
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
  app.decorate('queryService', new QueryService(db));
  app.decorate(
    'syncService',
    new SyncService(gitService, indexerService, logger === false ? undefined : logger),
  );
  app.decorate(
    'backupService',
    new BackupService(gitService, config.backupRemote, logger === false ? undefined : logger),
  );
  app.decorate('draftService', draftService);
  app.decorate('docService', docService);
  app.decorate('librarySettingsService', new LibrarySettingsService(config.libraryPath, gitService));

  // ライブラリのGitリポジトリ初期化(未初期化なら git init。設計06章6.1)
  app.addHook('onReady', async () => {
    await gitService.init();
  });

  app.register(fastifyMultipart, {
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
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
    registerQueryRoutes(instance);
    registerAttachmentRoutes(instance);
    registerLibraryRoutes(instance);
    instance.register(librarySettingsRoutes);
    instance.register(dailyNotesRoutes);
    instance.register(templatesRoutes);
  });

  // クライアントの静的配信(本番の単一ポート運用。設計01章1.4)
  if (config.staticRoot) {
    app.register(fastifyStatic, {
      root: config.staticRoot,
      prefix: '/',
      // ドットファイルは配信しない(防御的措置)
      dotfiles: 'ignore',
    });
    // SPAフォールバック: /api以外の未知パスはindex.htmlを返す
    app.setNotFoundHandler((req, reply) => {
      const lower = req.url.toLowerCase();
      if (lower.startsWith('/api/')) {
        return reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: 'エンドポイントがありません' } });
      }
      // ビルドアセットの取り違えはHTMLでなく404を返す(Unexpected token < の防止)
      if (lower.startsWith('/assets/')) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'ファイルがありません' } });
      }
      return reply.sendFile('index.html');
    });
  }

  app.get('/api/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      name: 'tsumiwiki',
      version: '0.1.0',
      time: new Date().toISOString(),
      backup: app.backupService.publicStatus(),
    };
  });

  return app;
}
