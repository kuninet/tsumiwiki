import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';
import { IndexerService } from '../services/indexer-service.js';

// ライブラリインデックスの再構築CLI(issue #21 / 設計02章2.3)
// 使い方: pnpm --filter @tsumiwiki/server reindex [-- --full]
//   --full: doc_index/doc_tags/doc_ftsを全削除してから全走査する(完全な再構築)
//   省略時: 差分リインデックス(mtime/sizeが変わった文書だけ再パース)

async function main(): Promise<void> {
  const full = process.argv.slice(2).includes('--full');

  const config = loadConfig();
  const db = openDatabase(config.dbPath);

  if (full) {
    db.exec('DELETE FROM doc_index; DELETE FROM doc_tags; DELETE FROM doc_fts;');
  }

  const indexer = new IndexerService(db, config.libraryPath);
  const result = await indexer.scanAll();
  console.log(
    `インデックス再構築完了: 更新${result.indexed}件 / 削除${result.removed}件 / 変更なし${result.unchanged}件`,
  );
  if (result.failedPaths.length > 0) {
    console.warn(`読み込みに失敗した文書(${result.failedPaths.length}件):`);
    for (const p of result.failedPaths) console.warn(`  - ${p}`);
  }
  // WALチェックポイントを確実に行う
  db.close();
}

main();
