import { mkdirSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config);

mkdirSync(config.libraryPath, { recursive: true });
const db = openDatabase(config.dbPath);

const app = buildApp({ config, db, logger });

// Git初期化(onReady)→起動時リインデックス→listen の順で立ち上げる
await app.ready();
const scan = await app.indexerService.scanAll();
logger.info(
  `起動時リインデックス完了: 更新${scan.indexed}件 / 削除${scan.removed}件 / 変更なし${scan.unchanged}件`,
);
if (scan.failedPaths.length > 0) {
  logger.warn({ failedPaths: scan.failedPaths }, '読み込みに失敗した文書があります(索引は継続)');
}

// 期限切れ編集ロックの定期掃除(FR-LOCK-03。判定自体はクエリ時にも行われる)
const lockSweep = setInterval(() => {
  const n = app.lockService.cleanupExpired();
  if (n > 0) logger.info(`期限切れの編集ロックを${n}件解放しました`);
  const d = app.draftService.cleanupStale();
  if (d > 0) logger.info(`保持期限を超えた下書きを${d}件回収しました`);
}, 60_000);
lockSweep.unref();

// 停止時にWALチェックポイント・ログフラッシュを確実に行う
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} を受信しました。シャットダウンします`);
  clearInterval(lockSweep);
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
