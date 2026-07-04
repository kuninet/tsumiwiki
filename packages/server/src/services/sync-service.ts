import type { Logger } from 'pino';
import { SYSTEM_AUTHOR, type GitService } from './git-service.js';
import type { IndexerService, ScanResult } from './indexer-service.js';
import { SerialQueue } from './serial-queue.js';

// 外部変更の取り込み(FR-DOC-08 / 設計06章6.4)
// Obsidian・生成AIエージェント等によるライブラリ直接変更を検知したら、
// sync:コミット(authorはシステム)として履歴へ取り込み、インデックスを更新する。
// 監視イベント・定期ポーリング・手動rescanのどこから呼ばれても直列に実行される。

export interface SyncResult extends ScanResult {
  committed: boolean; // 未コミットの外部変更を取り込んだか
}

export class SyncService {
  private readonly queue = new SerialQueue();

  constructor(
    private readonly git: GitService,
    private readonly indexer: IndexerService,
    private readonly logger?: Logger,
  ) {}

  async run(): Promise<SyncResult> {
    return this.queue.run(async () => {
      let committed = false;
      if (await this.git.hasExternalChanges()) {
        await this.git.commitAll('sync: external changes', SYSTEM_AUTHOR);
        committed = true;
      }
      const scan = await this.indexer.scanAll();
      if (committed || scan.indexed > 0 || scan.removed > 0) {
        this.logger?.info(
          { committed, indexed: scan.indexed, removed: scan.removed },
          '外部変更を取り込みました',
        );
      }
      if (scan.failedPaths.length > 0) {
        this.logger?.warn({ failedPaths: scan.failedPaths }, '取り込みに失敗した文書があります');
      }
      return { ...scan, committed };
    });
  }
}
