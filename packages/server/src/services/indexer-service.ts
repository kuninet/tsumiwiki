import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AppDatabase } from '../db/index.js';
import { isProtectedPath, normalizeRelPath } from '../lib/paths.js';
import { parseDocMeta } from './markdown-meta.js';

// ライブラリインデックスサービス(設計02章2.3)
// doc_index / doc_tags / doc_fts はライブラリから再構築可能な派生データとして管理する。
// - 起動時: 全走査し、mtime/sizeが変わったファイルだけ再パース(差分リインデックス)
// - 保存・外部変更時: 該当ファイルのみ更新
// - 索引は「キャッシュ」であり、一部ファイルの読み込み失敗でサービス全体を
//   止めない(失敗分はfailedPathsで報告し、他のファイルは索引を続行する)

export interface ScanResult {
  indexed: number; // 新規または更新
  removed: number; // 消えた文書
  unchanged: number;
  failedPaths: string[]; // 読み込み・パースに失敗した文書(継続対象)
}

interface IndexRow {
  doc_path: string;
  updated_at: string;
  size: number;
}

interface WalkedFile {
  mtime: string;
  size: number;
  absPath: string; // 実ディスク上のパス(NFDのままの可能性がある)
}

// パース済み文書(DB書き込み待ち)
interface ParsedRow {
  docPath: string;
  title: string;
  folder: string;
  mtime: string;
  size: number;
  frontmatterTags: string[];
  inlineTags: string[];
  body: string;
}

// フルリインデックス時のトランザクションあたり文書数
// (1文書=1コミットにするとWALのfsyncが文書数分発生するため)
const WRITE_BATCH_SIZE = 200;

export class IndexerService {
  constructor(
    private readonly db: AppDatabase,
    private readonly libraryPath: string,
  ) {}

  // ライブラリ全体を走査して差分リインデックスする
  async scanAll(): Promise<ScanResult> {
    const files = new Map<string, WalkedFile>();
    await this.walk('', files);

    const known = new Map<string, IndexRow>(
      (this.db.prepare('SELECT doc_path, updated_at, size FROM doc_index').all() as IndexRow[]).map(
        (r) => [r.doc_path, r],
      ),
    );

    // 変更ファイルのみ読み込み・パース(失敗はスキップして継続)
    const parsed: ParsedRow[] = [];
    const failedPaths: string[] = [];
    let unchanged = 0;
    for (const [relPath, meta] of files) {
      const row = known.get(relPath);
      known.delete(relPath);
      // 注意: mtime(ms)+size一致でunchanged判定のため、同一mtime tick内の
      // サイズ不変の書き換えは検知できない(設計02章2.3の方式どおり)
      if (row && row.updated_at === meta.mtime && row.size === meta.size) {
        unchanged++;
        continue;
      }
      try {
        parsed.push(
          await this.parseFile(relPath, meta.absPath, { mtime: meta.mtime, size: meta.size }),
        );
      } catch {
        failedPaths.push(relPath);
      }
    }

    // DB書き込みはバッチトランザクションでまとめる(コミット回数の削減)
    for (let i = 0; i < parsed.length; i += WRITE_BATCH_SIZE) {
      const chunk = parsed.slice(i, i + WRITE_BATCH_SIZE);
      this.db.transaction(() => {
        for (const row of chunk) this.writeRow(row);
      })();
    }

    // ファイルシステムに存在しなくなった文書をインデックスから除去
    let removed = 0;
    for (const gone of known.keys()) {
      this.removeFile(gone);
      removed++;
    }
    return { indexed: parsed.length, removed, unchanged, failedPaths };
  }

  // 1文書をインデックスへ反映する(新規・更新どちらも)。
  // absPathOverride: 走査時に得た実ディスク上のパス。NFDでファイル名が保存されている
  // ファイルシステム(Linux等)ではNFC正規化後のパスで開くと見つからないため、
  // DBキーはNFC・読み込みは実パス、と分離する。
  // override無しの経路は「ファイル名がNFCで書かれている(=本アプリが書いた)」前提。
  async indexFile(relPath: string, absPathOverride?: string): Promise<void> {
    const row = await this.parseFile(relPath, absPathOverride);
    this.db.transaction(() => this.writeRow(row))();
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

  // リネーム・移動時の付け替え。新パスは本アプリがNFCで書いたファイルである前提
  // (外部変更由来のNFDパスはscanAll経由で取り込むこと)
  async moveFile(oldRelPath: string, newRelPath: string): Promise<void> {
    this.removeFile(oldRelPath);
    await this.indexFile(newRelPath);
  }

  private async parseFile(
    relPath: string,
    absPathOverride?: string,
    statHint?: { mtime: string; size: number },
  ): Promise<ParsedRow> {
    const normalized = normalizeRelPath(relPath);
    const abs = absPathOverride ?? path.join(this.libraryPath, ...normalized.split('/'));
    const content = await readFile(abs, 'utf8');
    let mtime: string;
    let size: number;
    if (statHint) {
      ({ mtime, size } = statHint);
    } else {
      const st = await stat(abs);
      mtime = st.mtime.toISOString();
      size = st.size;
    }
    const meta = parseDocMeta(content);
    const folder = path.posix.dirname(normalized);
    return {
      docPath: normalized,
      title: path.posix.basename(normalized, '.md'),
      folder: folder === '.' ? '' : folder,
      mtime,
      size,
      frontmatterTags: meta.frontmatterTags,
      inlineTags: meta.inlineTags,
      body: meta.body,
    };
  }

  // トランザクション内から呼ぶこと
  private writeRow(row: ParsedRow): void {
    this.db
      .prepare(
        `INSERT INTO doc_index (doc_path, title, folder, updated_at, size)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(doc_path) DO UPDATE SET
           title = excluded.title, folder = excluded.folder,
           updated_at = excluded.updated_at, size = excluded.size`,
      )
      .run(row.docPath, row.title, row.folder, row.mtime, row.size);

    this.db.prepare('DELETE FROM doc_tags WHERE doc_path = ?').run(row.docPath);
    const insertTag = this.db.prepare(
      'INSERT OR IGNORE INTO doc_tags (doc_path, tag, source) VALUES (?, ?, ?)',
    );
    for (const tag of row.frontmatterTags) insertTag.run(row.docPath, tag, 'frontmatter');
    for (const tag of row.inlineTags) insertTag.run(row.docPath, tag, 'inline');

    this.db.prepare('DELETE FROM doc_fts WHERE doc_path = ?').run(row.docPath);
    this.db
      .prepare('INSERT INTO doc_fts (doc_path, title, body) VALUES (?, ?, ?)')
      .run(row.docPath, row.title, row.body);
  }

  private async walk(relDir: string, out: Map<string, WalkedFile>, absDirReal?: string): Promise<void> {
    const absDir = absDirReal ?? this.libraryPath;
    let entries: Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      // 読めないディレクトリはスキップして走査を継続する
      return;
    }
    for (const entry of entries) {
      const name = entry.name.normalize('NFC');
      const rel = relDir ? `${relDir}/${name}` : name;
      const absReal = path.join(absDir, entry.name);
      // 設定系ドットフォルダ(.git/.obsidian等)と.trash(ネスト含む)は索引しない
      if (isProtectedPath(rel) || name === '.trash') continue;
      if (entry.isDirectory()) {
        await this.walk(rel, out, absReal);
      } else if (entry.isFile() && name.toLowerCase().endsWith('.md')) {
        try {
          const st = await stat(absReal);
          out.set(rel, { mtime: st.mtime.toISOString(), size: st.size, absPath: absReal });
        } catch {
          // 走査中に消えた等。スキップして継続
        }
      }
    }
  }
}
