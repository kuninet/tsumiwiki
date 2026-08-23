import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AppDatabase } from '../db/index.js';
import { isIndexedFileName } from '../lib/attachments.js';
import { isProtectedPath, normalizeRelPath } from '../lib/paths.js';
import { parseDocMeta } from './markdown-meta.js';

// ライブラリインデックスサービス(設計02章2.3)
// doc_index / doc_tags / doc_fts / attachment_index はライブラリから再構築可能な
// 派生データとして管理する。
// - 起動時: 全走査し、mtime/sizeが変わったファイルだけ再パース(差分リインデックス)
// - 保存・外部変更時: 該当ファイルのみ更新
// - 索引は「キャッシュ」であり、一部ファイルの読み込み失敗でサービス全体を
//   止めない(失敗分はfailedPathsで報告し、他のファイルは索引を続行する)
// - 添付(画像等)はパース不要のためstat差分のみでattachment_indexをupsertする

export interface ScanResult {
  indexed: number; // 新規または更新(文書)
  removed: number; // 消えた文書
  unchanged: number; // 変更なし(文書)
  failedPaths: string[]; // 読み込み・パースに失敗した文書(継続対象)
  attachmentsIndexed: number; // 新規または更新(添付)
  attachmentsRemoved: number; // 消えた添付
}

interface IndexRow {
  doc_path: string;
  updated_at: string;
  size: number;
}

interface AttachmentIndexRow {
  rel_path: string;
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

// 添付索引の1行(DB書き込み待ち)
interface AttachmentRow {
  relPath: string;
  name: string;
  nameKey: string;
  folder: string;
  updatedAt: string;
  size: number;
}

// 解決候補(resolveAttachment用)
interface AttachmentCandidate {
  rel_path: string;
  folder: string;
}

// フルリインデックス時のトランザクションあたり文書数
// (1文書=1コミットにするとWALのfsyncが文書数分発生するため)
const WRITE_BATCH_SIZE = 200;

export class IndexerService {
  constructor(
    private readonly db: AppDatabase,
    private readonly libraryPath: string,
  ) {}

  // ライブラリ全体を走査して差分リインデックスする(文書・添付の両方)
  async scanAll(): Promise<ScanResult> {
    const docs = new Map<string, WalkedFile>();
    const attachments = new Map<string, WalkedFile>();
    await this.walk('', docs, attachments);

    const known = new Map<string, IndexRow>(
      (this.db.prepare('SELECT doc_path, updated_at, size FROM doc_index').all() as IndexRow[]).map(
        (r) => [r.doc_path, r],
      ),
    );

    // 変更ファイルのみ読み込み・パース(失敗はスキップして継続)
    const parsed: ParsedRow[] = [];
    const failedPaths: string[] = [];
    let unchanged = 0;
    for (const [relPath, meta] of docs) {
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

    // 添付索引の差分更新(パース不要。stat情報のみでupsert)
    const knownAttachments = new Map<string, AttachmentIndexRow>(
      (
        this.db
          .prepare('SELECT rel_path, updated_at, size FROM attachment_index')
          .all() as AttachmentIndexRow[]
      ).map((r) => [r.rel_path, r]),
    );
    const attachmentRows: AttachmentRow[] = [];
    for (const [relPath, meta] of attachments) {
      const row = knownAttachments.get(relPath);
      knownAttachments.delete(relPath);
      if (row && row.updated_at === meta.mtime && row.size === meta.size) continue;
      attachmentRows.push(this.buildAttachmentRow(relPath, meta));
    }
    for (let i = 0; i < attachmentRows.length; i += WRITE_BATCH_SIZE) {
      const chunk = attachmentRows.slice(i, i + WRITE_BATCH_SIZE);
      this.db.transaction(() => {
        for (const row of chunk) this.writeAttachmentRow(row);
      })();
    }
    let attachmentsRemoved = 0;
    for (const gone of knownAttachments.keys()) {
      this.removeAttachment(gone);
      attachmentsRemoved++;
    }

    return {
      indexed: parsed.length,
      removed,
      unchanged,
      failedPaths,
      attachmentsIndexed: attachmentRows.length,
      attachmentsRemoved,
    };
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

  // 1添付をインデックスへ反映する(新規・更新どちらも)。stat結果のみ使う。
  // 本アプリがNFCで書いたファイルである前提(indexFileと同じ注意書き)
  async indexAttachment(relPath: string): Promise<void> {
    const normalized = normalizeRelPath(relPath);
    const abs = path.join(this.libraryPath, ...normalized.split('/'));
    const st = await stat(abs);
    const row = this.buildAttachmentRow(normalized, {
      mtime: st.mtime.toISOString(),
      size: st.size,
      absPath: abs,
    });
    this.db.transaction(() => this.writeAttachmentRow(row))();
  }

  // 添付をインデックスから除去する(削除・ごみ箱移動時)
  removeAttachment(relPath: string): void {
    const normalized = normalizeRelPath(relPath);
    this.db.prepare('DELETE FROM attachment_index WHERE rel_path = ?').run(normalized);
  }

  // リネーム・移動時の付け替え
  async moveAttachment(oldRelPath: string, newRelPath: string): Promise<void> {
    this.removeAttachment(oldRelPath);
    await this.indexAttachment(newRelPath);
  }

  // Obsidian同等のファイル名索引解決(issue #198)。
  // target(![[target]]の中身)をfromDocPath(参照元文書)のフォルダを起点に解決する。
  // 解決できなければnull(呼び出し側で404にする)。
  //
  // SQLiteのlower()はASCII専用で非ASCII大文字(例: Ä)を含むパス指定を正しく
  // 小文字化できないため、SQL側のlower()/LIKEは使わない。basenameのname_key
  // (索引つき・JS toLowerCase())で候補を絞り込んでから、パス指定時は
  // JS側の文字列比較(完全一致 or `/`区切りの末尾一致)で絞る。
  resolveAttachment(target: string, fromDocPath: string): string | null {
    const normalizedTarget = this.normalizeEmbedTarget(target);
    if (!normalizedTarget) return null;
    const fromFolder = this.folderOfDoc(fromDocPath);
    const hasPath = normalizedTarget.includes('/');
    const targetLower = normalizedTarget.toLowerCase();
    const basenameLower = path.posix.basename(normalizedTarget).toLowerCase();

    const byName = this.db
      .prepare('SELECT rel_path, folder FROM attachment_index WHERE name_key = ?')
      .all(basenameLower) as AttachmentCandidate[];

    const candidates = hasPath
      ? byName.filter((c) => {
          const relLower = c.rel_path.toLowerCase();
          return relLower === targetLower || relLower.endsWith(`/${targetLower}`);
        })
      : byName;

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].rel_path;
    // パス指定時のみ「ヴォルトルート起点の完全パス一致」を最優先にする(仕様外/レビュー指摘)。
    // 名前のみ指定(hasPath=false)でこれを有効にすると、ルート直下の同名ファイルが
    // 同フォルダ優先より不当に優先されてしまうため対象外とする
    const isExactPath = hasPath ? (relPath: string) => relPath.toLowerCase() === targetLower : () => false;
    return this.pickBestCandidate(fromFolder, candidates, isExactPath);
  }

  // target文字列の正規化。NFC・前後空白除去・\→/・先頭の./と/を除去。
  // 空、または..セグメントを含む場合はnull(仕様A-4)
  private normalizeEmbedTarget(target: string): string | null {
    const unified = target.normalize('NFC').trim().replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
    if (!unified) return null;
    const segments = unified.split('/').filter((s) => s !== '' && s !== '.');
    if (segments.length === 0 || segments.some((s) => s === '..')) return null;
    return segments.join('/');
  }

  // fromDocPathの親フォルダ('' = ルート)。空・不正な入力は''扱い
  private folderOfDoc(fromDocPath: string): string {
    if (!fromDocPath) return '';
    try {
      const normalized = normalizeRelPath(fromDocPath);
      if (!normalized) return '';
      const dir = path.posix.dirname(normalized);
      return dir === '.' ? '' : dir;
    } catch {
      return '';
    }
  }

  // 複数候補から1件を優先順位で絞り込む(仕様A-4の4. + レビュー指摘の完全パス一致優先)
  // 0. ヴォルトルート起点の完全パスがtargetと一致(大文字小文字無視。パス指定時のみ)
  // 1. 参照元と同じフォルダ 2. 共通祖先が深い 3. パスが浅い 4. 辞書順
  private pickBestCandidate(
    fromFolder: string,
    candidates: AttachmentCandidate[],
    isExactPath: (relPath: string) => boolean,
  ): string {
    const fromSegments = fromFolder ? fromFolder.split('/') : [];
    const commonDepth = (folder: string): number => {
      const segments = folder ? folder.split('/') : [];
      let n = 0;
      while (n < fromSegments.length && n < segments.length && fromSegments[n] === segments[n]) n++;
      return n;
    };
    const sorted = [...candidates].sort((a, b) => {
      const aExact = isExactPath(a.rel_path) ? 0 : 1;
      const bExact = isExactPath(b.rel_path) ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const aSame = a.folder === fromFolder ? 0 : 1;
      const bSame = b.folder === fromFolder ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;
      const depthDiff = commonDepth(b.folder) - commonDepth(a.folder);
      if (depthDiff !== 0) return depthDiff;
      const segCountDiff = a.rel_path.split('/').length - b.rel_path.split('/').length;
      if (segCountDiff !== 0) return segCountDiff;
      if (a.rel_path < b.rel_path) return -1;
      if (a.rel_path > b.rel_path) return 1;
      return 0;
    });
    return sorted[0].rel_path;
  }

  private buildAttachmentRow(relPath: string, meta: WalkedFile): AttachmentRow {
    const normalized = normalizeRelPath(relPath);
    const name = path.posix.basename(normalized);
    const folder = path.posix.dirname(normalized);
    return {
      relPath: normalized,
      name,
      nameKey: name.toLowerCase(),
      folder: folder === '.' ? '' : folder,
      updatedAt: meta.mtime,
      size: meta.size,
    };
  }

  // トランザクション内から呼ぶこと
  private writeAttachmentRow(row: AttachmentRow): void {
    this.db
      .prepare(
        `INSERT INTO attachment_index (rel_path, name, name_key, folder, updated_at, size)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(rel_path) DO UPDATE SET
           name = excluded.name, name_key = excluded.name_key, folder = excluded.folder,
           updated_at = excluded.updated_at, size = excluded.size`,
      )
      .run(row.relPath, row.name, row.nameKey, row.folder, row.updatedAt, row.size);
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

  private async walk(
    relDir: string,
    docs: Map<string, WalkedFile>,
    attachments: Map<string, WalkedFile>,
    absDirReal?: string,
  ): Promise<void> {
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
        await this.walk(rel, docs, attachments, absReal);
      } else if (entry.isFile()) {
        const lower = name.toLowerCase();
        if (lower.endsWith('.md')) {
          try {
            const st = await stat(absReal);
            docs.set(rel, { mtime: st.mtime.toISOString(), size: st.size, absPath: absReal });
          } catch {
            // 走査中に消えた等。スキップして継続
          }
        } else if (isIndexedFileName(name)) {
          try {
            const st = await stat(absReal);
            attachments.set(rel, { mtime: st.mtime.toISOString(), size: st.size, absPath: absReal });
          } catch {
            // 走査中に消えた等。スキップして継続
          }
        }
      }
    }
  }
}
