import { mkdirSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { createLogger } from './logger.js';
import { LibraryWatcher } from './services/library-watcher.js';

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

// 外部変更の自動取り込み(FR-DOC-08 / 設計06章6.4の多重防御)
// ①ファイルシステム監視(デバウンス3秒) ②定期ポーリング(5分) ③手動rescan API
const watcher = new LibraryWatcher(config.libraryPath, () => {
  void app.syncService.run().catch((e) => logger.error(e, '外部変更の取り込みに失敗しました'));
});
watcher.start();
const syncPoll = setInterval(() => {
  void app.syncService.run().catch((e) => logger.error(e, '外部変更の取り込みに失敗しました'));
}, 5 * 60_000);
syncPoll.unref();

// バックアップpush(NFR-AVL-02。BACKUP_REMOTE設定時のみ)
let backupTimer: NodeJS.Timeout | null = null;
if (app.backupService.configured) {
  backupTimer = setInterval(() => {
    void app.backupService.pushNow();
  }, config.backupPushIntervalMinutes * 60_000);
  backupTimer.unref();
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
  clearInterval(syncPoll);
  if (backupTimer) clearInterval(backupTimer);
  await watcher.stop();
  // 正常終了時に最後のバックアップpushを試みる(設計06章6.5)
  await app.backupService.pushNow();
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
