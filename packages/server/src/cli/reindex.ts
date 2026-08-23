import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';
import { IndexerService } from '../services/indexer-service.js';

// ライブラリインデックスの再構築CLI(issue #21 / 設計02章2.3)
// 使い方: pnpm --filter @tsumiwiki/server reindex [-- --full]
//   --full: doc_index/doc_tags/doc_fts/attachment_indexを全削除してから全走査する(完全な再構築)
//   省略時: 差分リインデックス(mtime/sizeが変わったファイルだけ再パース。添付はstat差分のみ)

async function main(): Promise<void> {
  const full = process.argv.slice(2).includes('--full');

  const config = loadConfig();
  const db = openDatabase(config.dbPath);

  if (full) {
    db.exec(
      'DELETE FROM doc_index; DELETE FROM doc_tags; DELETE FROM doc_fts; DELETE FROM attachment_index;',
    );
  }

  const indexer = new IndexerService(db, config.libraryPath);
  const result = await indexer.scanAll();
  console.log(
    `インデックス再構築完了: 更新${result.indexed}件 / 削除${result.removed}件 / 変更なし${result.unchanged}件` +
      ` / 添付更新${result.attachmentsIndexed}件 / 添付削除${result.attachmentsRemoved}件`,
  );
  if (result.failedPaths.length > 0) {
    console.warn(`読み込みに失敗した文書(${result.failedPaths.length}件):`);
    for (const p of result.failedPaths) console.warn(`  - ${p}`);
  }
  // WALチェックポイントを確実に行う
  db.close();
}

main();
