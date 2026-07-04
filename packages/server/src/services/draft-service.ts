import type { AppDatabase } from '../db/index.js';
import { normalizeRelPath } from '../lib/paths.js';

// 自動保存の下書き(FR-EDIT-08)
// - 編集ロック保持者のみ書き込める(ルート層で検証)
// - (doc_path, user_id)ごとに1件。ロック失効後に別ユーザーが編集しても
//   元ユーザーの下書き(クラッシュ復帰用)は上書きされない
// - Git履歴には残さない。明示保存(PUT /api/docs)成功時に本人の下書きを削除
// - 放置された下書きは保持期限で回収する(孤児化防止)

export interface Draft {
  docPath: string;
  userId: number;
  content: string;
  updatedAt: string;
}

interface DraftRow {
  doc_path: string;
  user_id: number;
  content: string;
  updated_at: string;
}

// 下書きの保持日数(これを超えた放置下書きは掃除ジョブが回収する)
export const DRAFT_RETENTION_DAYS = 14;

// SQLのLIKEはワイルドカード(_ %)とASCII大小無視の穴があるため、
// フォルダ前方一致はバイト順の半開区間で表す。'0'は'/'(0x2F)の次のバイト
function folderRange(folderNorm: string): { lo: string; hi: string } {
  return { lo: `${folderNorm}/`, hi: `${folderNorm}0` };
}

export class DraftService {
  constructor(private readonly db: AppDatabase) {}

  save(relPath: string, userId: number, content: string): void {
    const normalized = normalizeRelPath(relPath);
    this.db
      .prepare(
        `INSERT INTO drafts (doc_path, user_id, content, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(doc_path, user_id) DO UPDATE SET
           content = excluded.content,
           updated_at = excluded.updated_at`,
      )
      .run(normalized, userId, content, new Date().toISOString());
  }

  // 自分の下書きのみ取得できる
  getOwn(relPath: string, userId: number): Draft | null {
    const row = this.db
      .prepare('SELECT * FROM drafts WHERE doc_path = ? AND user_id = ?')
      .get(normalizeRelPath(relPath), userId) as DraftRow | undefined;
    if (!row) return null;
    return {
      docPath: row.doc_path,
      userId: row.user_id,
      content: row.content,
      updatedAt: row.updated_at,
    };
  }

  // 本人の下書きを削除(明示保存の成功時・破棄時)
  removeOwn(relPath: string, userId: number): void {
    this.db
      .prepare('DELETE FROM drafts WHERE doc_path = ? AND user_id = ?')
      .run(normalizeRelPath(relPath), userId);
  }

  // 文書削除時: 全ユーザーの下書きを削除
  removeAll(relPath: string): void {
    this.db.prepare('DELETE FROM drafts WHERE doc_path = ?').run(normalizeRelPath(relPath));
  }

  repath(oldRelPath: string, newRelPath: string): void {
    const oldNorm = normalizeRelPath(oldRelPath);
    const newNorm = normalizeRelPath(newRelPath);
    this.db.transaction(() => {
      // 移動先に残る孤児下書きを先に除去してPK衝突を防ぐ
      this.db.prepare('DELETE FROM drafts WHERE doc_path = ?').run(newNorm);
      this.db.prepare('UPDATE drafts SET doc_path = ? WHERE doc_path = ?').run(newNorm, oldNorm);
    })();
  }

  repathFolder(oldFolder: string, newFolder: string): void {
    const oldNorm = normalizeRelPath(oldFolder);
    const newNorm = normalizeRelPath(newFolder);
    const oldRange = folderRange(oldNorm);
    const newRange = folderRange(newNorm);
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM drafts WHERE doc_path >= ? AND doc_path < ?')
        .run(newRange.lo, newRange.hi);
      this.db
        .prepare(
          `UPDATE drafts SET doc_path = ? || SUBSTR(doc_path, ?)
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
      .prepare('DELETE FROM drafts WHERE doc_path = ? OR (doc_path >= ? AND doc_path < ?)')
      .run(normalized, range.lo, range.hi);
  }

  // 保持期限を超えた放置下書きの回収(掃除ジョブから呼ぶ)
  cleanupStale(retentionDays: number = DRAFT_RETENTION_DAYS): number {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60_000).toISOString();
    const info = this.db.prepare('DELETE FROM drafts WHERE updated_at < ?').run(cutoff);
    return info.changes;
  }
}
