import type { Logger } from 'pino';
import type { GitService } from './git-service.js';

// バックアップpush(NFR-AVL-02 / 設計06章6.5)
// ファイルサーバー上のbareリポジトリへ定期push。失敗してもWiki本体は継続し、
// 状態はヘルスチェックAPIで確認できる(設計03章)。

export interface BackupStatus {
  configured: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export class BackupService {
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly git: GitService,
    private readonly remoteUrl: string | null,
    private readonly logger?: Logger,
  ) {}

  get configured(): boolean {
    return this.remoteUrl !== null;
  }

  // push実行。失敗は状態記録とログのみ(次回定期で自動リトライ)
  async pushNow(): Promise<boolean> {
    if (!this.remoteUrl) return false;
    try {
      await this.git.pushBackup(this.remoteUrl);
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = null;
      this.logger?.info({ remote: this.remoteUrl }, 'バックアップpush完了');
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.logger?.error({ err: e, remote: this.remoteUrl }, 'バックアップpushに失敗しました');
      return false;
    }
  }

  status(): BackupStatus {
    return {
      configured: this.configured,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }
}
