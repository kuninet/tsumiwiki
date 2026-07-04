import type { AppDatabase } from '../db/index.js';
import { normalizeRelPath } from '../lib/paths.js';

// 編集ロック(FR-LOCK / 設計03章)
// - 文書パスに対して高々1つのロック。取得者のみ保存できる
// - ハートビート(refreshed_at)が途絶えたロックはタイムアウトで自動失効
//   (期限判定はクエリ時に行い、掃除ジョブは補助)

export interface LockInfo {
  userId: number;
  displayName: string;
  acquiredAt: string;
  refreshedAt: string;
}

export class DocLockedError extends Error {
  constructor(public readonly holder: LockInfo) {
    super(`この文書は${holder.displayName}さんが編集中です`);
    this.name = 'DocLockedError';
  }
}

export class LockExpiredError extends Error {
  constructor() {
    super('編集ロックが失効しています。再度編集を開始してください');
    this.name = 'LockExpiredError';
  }
}

// SQLのLIKEはワイルドカード(_ %)とASCII大小無視の穴があるため、
// フォルダ前方一致はバイト順の半開区間で表す。'0'は'/'(0x2F)の次のバイト
function folderRange(folderNorm: string): { lo: string; hi: string } {
  return { lo: `${folderNorm}/`, hi: `${folderNorm}0` };
}

interface LockRow {
  doc_path: string;
  user_id: number;
  display_name: string;
  acquired_at: string;
  refreshed_at: string;
}

export class LockService {
  constructor(
    private readonly db: AppDatabase,
    private readonly timeoutMinutes: number,
  ) {}

  private cutoff(): string {
    return new Date(Date.now() - this.timeoutMinutes * 60_000).toISOString();
  }

  // 有効なロックを取得する(期限切れは無視される)
  getActive(relPath: string): LockInfo | null {
    const normalized = normalizeRelPath(relPath);
    const row = this.db
      .prepare(
        `SELECT l.doc_path, l.user_id, l.acquired_at, l.refreshed_at, u.display_name
         FROM locks l JOIN users u ON u.id = l.user_id
         WHERE l.doc_path = ? AND l.refreshed_at >= ?`,
      )
      .get(normalized, this.cutoff()) as LockRow | undefined;
    if (!row) return null;
    return {
      userId: row.user_id,
      displayName: row.display_name,
      acquiredAt: row.acquired_at,
      refreshedAt: row.refreshed_at,
    };
  }

  // ロックを取得する。他ユーザーの有効ロックがあればDocLockedError
  acquire(relPath: string, userId: number): LockInfo {
    const normalized = normalizeRelPath(relPath);
    const current = this.getActive(normalized);
    if (current && current.userId !== userId) {
      throw new DocLockedError(current);
    }
    const now = new Date().toISOString();
    // 期限切れロック・自分の既存ロックは上書き(再取得)する
    this.db
      .prepare(
        `INSERT INTO locks (doc_path, user_id, acquired_at, refreshed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(doc_path) DO UPDATE SET
           user_id = excluded.user_id,
           acquired_at = CASE WHEN locks.user_id = excluded.user_id THEN locks.acquired_at ELSE excluded.acquired_at END,
           refreshed_at = excluded.refreshed_at`,
      )
      .run(normalized, userId, now, now);
    return this.getActive(normalized)!;
  }

  // ハートビート(FR-LOCK-03対策の生存通知)。保持していなければLockExpiredError
  refresh(relPath: string, userId: number): void {
    const normalized = normalizeRelPath(relPath);
    const current = this.getActive(normalized);
    if (!current) throw new LockExpiredError();
    if (current.userId !== userId) throw new DocLockedError(current);
    this.db
      .prepare('UPDATE locks SET refreshed_at = ? WHERE doc_path = ? AND user_id = ?')
      .run(new Date().toISOString(), normalized, userId);
  }

  // ロック解放。他者のロックは解放できない(admin強制解除はforceReleaseで)
  release(relPath: string, userId: number): void {
    const normalized = normalizeRelPath(relPath);
    const current = this.getActive(normalized);
    if (current && current.userId !== userId) {
      throw new DocLockedError(current);
    }
    this.db.prepare('DELETE FROM locks WHERE doc_path = ?').run(normalized);
  }

  // admin用の強制解除(FR-LOCK-04)
  forceRelease(relPath: string): void {
    const normalized = normalizeRelPath(relPath);
    this.db.prepare('DELETE FROM locks WHERE doc_path = ?').run(normalized);
  }

  // 保存等の操作前検証: 呼び出しユーザーが有効なロックを保持していること
  assertHeldBy(relPath: string, userId: number): void {
    const current = this.getActive(relPath);
    if (!current) throw new LockExpiredError();
    if (current.userId !== userId) throw new DocLockedError(current);
  }

  // 削除・移動前の検証: 他ユーザーの有効ロックがないこと(自分のロック・無ロックは可)
  assertNotLockedByOther(relPath: string, userId: number): void {
    const current = this.getActive(relPath);
    if (current && current.userId !== userId) {
      throw new DocLockedError(current);
    }
  }

  // 指定フォルダ配下に他ユーザーの有効ロックがないこと(フォルダ移動・削除用)
  assertFolderNotLockedByOther(folderRelPath: string, userId: number): void {
    const normalized = normalizeRelPath(folderRelPath);
    const range = folderRange(normalized);
    const row = this.db
      .prepare(
        `SELECT l.doc_path, l.user_id, l.acquired_at, l.refreshed_at, u.display_name
         FROM locks l JOIN users u ON u.id = l.user_id
         WHERE (l.doc_path = ? OR (l.doc_path >= ? AND l.doc_path < ?))
           AND l.refreshed_at >= ? AND l.user_id != ?
         LIMIT 1`,
      )
      .get(normalized, range.lo, range.hi, this.cutoff(), userId) as LockRow | undefined;
    if (row) {
      throw new DocLockedError({
        userId: row.user_id,
        displayName: row.display_name,
        acquiredAt: row.acquired_at,
        refreshedAt: row.refreshed_at,
      });
    }
  }

  // リネーム・移動時のロックの追随。移動先の孤児ロックはPK衝突を防ぐため先に除去
  repath(oldRelPath: string, newRelPath: string): void {
    const oldNorm = normalizeRelPath(oldRelPath);
    const newNorm = normalizeRelPath(newRelPath);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM locks WHERE doc_path = ?').run(newNorm);
      this.db.prepare('UPDATE locks SET doc_path = ? WHERE doc_path = ?').run(newNorm, oldNorm);
    })();
  }

  repathFolder(oldFolder: string, newFolder: string): void {
    const oldNorm = normalizeRelPath(oldFolder);
    const newNorm = normalizeRelPath(newFolder);
    const oldRange = folderRange(oldNorm);
    const newRange = folderRange(newNorm);
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM locks WHERE doc_path >= ? AND doc_path < ?')
        .run(newRange.lo, newRange.hi);
      this.db
        .prepare(
          `UPDATE locks SET doc_path = ? || SUBSTR(doc_path, ?)
           WHERE doc_path >= ? AND doc_path < ?`,
        )
        .run(newNorm, oldNorm.length + 1, oldRange.lo, oldRange.hi);
    })();
  }

  // フォルダ削除時の掃除
  removeUnder(folderRelPath: string): void {
    const normalized = normalizeRelPath(folderRelPath);
    const range = folderRange(normalized);
    this.db
      .prepare('DELETE FROM locks WHERE doc_path = ? OR (doc_path >= ? AND doc_path < ?)')
      .run(normalized, range.lo, range.hi);
  }

  // 期限切れロックの掃除(定期ジョブから呼ぶ。FR-LOCK-03)
  cleanupExpired(): number {
    const info = this.db.prepare('DELETE FROM locks WHERE refreshed_at < ?').run(this.cutoff());
    return info.changes;
  }
}
