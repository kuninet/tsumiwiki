import type { AppDatabase } from '../db/index.js';
import { normalizeRelPath } from '../lib/paths.js';

// 自動保存の下書き(FR-EDIT-08)
// - 編集ロック保持者のみ書き込める(ルート層で検証)
// - Git履歴には残さない。明示保存(PUT /api/docs)成功時に削除する
// - ブラウザクラッシュ後の復帰に使う(編集開始時に自分の下書きがあれば提示)

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

export class DraftService {
  constructor(private readonly db: AppDatabase) {}

  save(relPath: string, userId: number, content: string): void {
    const normalized = normalizeRelPath(relPath);
    this.db
      .prepare(
        `INSERT INTO drafts (doc_path, user_id, content, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(doc_path) DO UPDATE SET
           user_id = excluded.user_id,
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

  remove(relPath: string): void {
    this.db.prepare('DELETE FROM drafts WHERE doc_path = ?').run(normalizeRelPath(relPath));
  }

  repath(oldRelPath: string, newRelPath: string): void {
    this.db
      .prepare('UPDATE drafts SET doc_path = ? WHERE doc_path = ?')
      .run(normalizeRelPath(newRelPath), normalizeRelPath(oldRelPath));
  }

  // フォルダ削除時の掃除
  removeUnder(folderRelPath: string): void {
    const normalized = normalizeRelPath(folderRelPath);
    this.db
      .prepare('DELETE FROM drafts WHERE doc_path = ? OR doc_path LIKE ?')
      .run(normalized, `${normalized}/%`);
  }

  repathFolder(oldFolder: string, newFolder: string): void {
    const oldNorm = normalizeRelPath(oldFolder);
    const newNorm = normalizeRelPath(newFolder);
    this.db
      .prepare(
        `UPDATE drafts SET doc_path = ? || SUBSTR(doc_path, ?)
         WHERE doc_path = ? OR doc_path LIKE ?`,
      )
      .run(newNorm, oldNorm.length + 1, oldNorm, `${oldNorm}/%`);
  }
}
