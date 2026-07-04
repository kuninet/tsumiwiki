import { mkdirSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { createLogger } from './logger.js';
import { IndexerService } from './services/indexer-service.js';

const config = loadConfig();
const logger = createLogger(config);

mkdirSync(config.libraryPath, { recursive: true });
const db = openDatabase(config.dbPath);

// 起動時にライブラリを走査して差分リインデックス(設計02章2.3)。
// 外部ツールによる直接変更もここで索引へ反映される
const indexer = new IndexerService(db, config.libraryPath);
const scan = await indexer.scanAll();
logger.info(
  `起動時リインデックス完了: 更新${scan.indexed}件 / 削除${scan.removed}件 / 変更なし${scan.unchanged}件`,
);
if (scan.failedPaths.length > 0) {
  logger.warn({ failedPaths: scan.failedPaths }, '読み込みに失敗した文書があります(索引は継続)');
}

const app = buildApp({ config, db, logger });

// 停止時にWALチェックポイント・ログフラッシュを確実に行う
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} を受信しました。シャットダウンします`);
  await app.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

app.listen({ port: config.port, host: config.host }).catch((err) => {
  logger.error(err, 'サーバー起動に失敗しました');
  process.exit(1);
});
