import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AppDatabase } from '../db/index.js';
import { isProtectedPath, normalizeRelPath } from '../lib/paths.js';
import { parseDocMeta } from './markdown-meta.js';

// ライブラリインデックスサービス(設計02章2.3)
// doc_index / doc_tags / doc_fts はライブラリから再構築可能な派生データとして管理する。
// - 起動時: 全走査し、mtime/sizeが変わったファイルだけ再パース(差分リインデックス)
// - 保存・外部変更時: 該当ファイルのみ更新

export interface ScanResult {
  indexed: number; // 新規または更新
  removed: number; // 消えた文書
  unchanged: number;
}

interface IndexRow {
  doc_path: string;
  updated_at: string;
  size: number;
}

export class IndexerService {
  constructor(
    private readonly db: AppDatabase,
    private readonly libraryPath: string,
  ) {}

  // ライブラリ全体を走査して差分リインデックスする
  async scanAll(): Promise<ScanResult> {
    const files = new Map<string, { mtime: string; size: number; absPath: string }>();
    await this.walk('', files);

    const known = new Map<string, IndexRow>(
      (this.db.prepare('SELECT doc_path, updated_at, size FROM doc_index').all() as IndexRow[]).map(
        (r) => [r.doc_path, r],
      ),
    );

    let indexed = 0;
    let unchanged = 0;
    for (const [relPath, meta] of files) {
      const row = known.get(relPath);
      known.delete(relPath);
      if (row && row.updated_at === meta.mtime && row.size === meta.size) {
        unchanged++;
        continue;
      }
      await this.indexFile(relPath, meta.absPath);
      indexed++;
    }

    // ファイルシステムに存在しなくなった文書をインデックスから除去
    let removed = 0;
    for (const gone of known.keys()) {
      this.removeFile(gone);
      removed++;
    }
    return { indexed, removed, unchanged };
  }

  // 1文書をインデックスへ反映する(新規・更新どちらも)。
  // absPathOverride: 走査時に得た実ディスク上のパス。NFDでファイル名が保存されている
  // ファイルシステム(Linux等)ではNFC正規化後のパスで開くと見つからないため、
  // DBキーはNFC・読み込みは実パス、と分離する
  async indexFile(relPath: string, absPathOverride?: string): Promise<void> {
    const normalized = normalizeRelPath(relPath);
    const abs = absPathOverride ?? path.join(this.libraryPath, ...normalized.split('/'));
    const [content, st] = await Promise.all([readFile(abs, 'utf8'), stat(abs)]);
    const meta = parseDocMeta(content);
    const title = path.posix.basename(normalized, '.md');
    const folder = path.posix.dirname(normalized);

    const upsert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO doc_index (doc_path, title, folder, updated_at, size)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(doc_path) DO UPDATE SET
             title = excluded.title, folder = excluded.folder,
             updated_at = excluded.updated_at, size = excluded.size`,
        )
        .run(normalized, title, folder === '.' ? '' : folder, st.mtime.toISOString(), st.size);

      this.db.prepare('DELETE FROM doc_tags WHERE doc_path = ?').run(normalized);
      const insertTag = this.db.prepare(
        'INSERT OR IGNORE INTO doc_tags (doc_path, tag, source) VALUES (?, ?, ?)',
      );
      for (const tag of meta.frontmatterTags) insertTag.run(normalized, tag, 'frontmatter');
      for (const tag of meta.inlineTags) insertTag.run(normalized, tag, 'inline');

      this.db.prepare('DELETE FROM doc_fts WHERE doc_path = ?').run(normalized);
      this.db
        .prepare('INSERT INTO doc_fts (doc_path, title, body) VALUES (?, ?, ?)')
        .run(normalized, title, meta.body);
    });
    upsert();
  }

  // 文書をインデックスから除去する(削除・ごみ箱移動時)
  removeFile(relPath: string): void {
    const normalized = normalizeRelPath(relPath);
    const remove = this.db.transaction(() => {
      this.db.prepare('DELETE FROM doc_index WHERE doc_path = ?').run(normalized);
      this.db.prepare('DELETE FROM doc_tags WHERE doc_path = ?').run(normalized);
      this.db.prepare('DELETE FROM doc_fts WHERE doc_path = ?').run(normalized);
    });
    remove();
  }

  // リネーム・移動時の付け替え(再パースせずキーだけ更新)
  async moveFile(oldRelPath: string, newRelPath: string): Promise<void> {
    this.removeFile(oldRelPath);
    await this.indexFile(newRelPath);
  }

  private async walk(
    relDir: string,
    out: Map<string, { mtime: string; size: number; absPath: string }>,
    absDirReal?: string,
  ): Promise<void> {
    // absDirRealは実ディスク上のディレクトリパス(NFDのままの可能性がある)
    const absDir = absDirReal ?? this.libraryPath;
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name.normalize('NFC');
      const rel = relDir ? `${relDir}/${name}` : name;
      const absReal = path.join(absDir, entry.name);
      // 設定系ドットフォルダ(.git/.obsidian等)と.trashは索引しない
      if (isProtectedPath(rel) || rel === '.trash' || rel.startsWith('.trash/')) continue;
      if (entry.isDirectory()) {
        await this.walk(rel, out, absReal);
      } else if (entry.isFile() && name.toLowerCase().endsWith('.md')) {
        const st = await stat(absReal);
        out.set(rel, { mtime: st.mtime.toISOString(), size: st.size, absPath: absReal });
      }
    }
  }
}
