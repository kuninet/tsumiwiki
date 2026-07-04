import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import matter from 'gray-matter';
import type { Logger } from 'pino';
import { parseDocument as parseYamlDocument, stringify as yamlStringify } from 'yaml';
import type { DocResponse, DocSummary, TreeResponse } from '@tsumiwiki/shared';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import { InvalidPathError, isProtectedPath, normalizeRelPath, resolveInLibrary } from '../lib/paths.js';
import type { GitAuthor, GitService } from './git-service.js';
import type { IndexerService } from './indexer-service.js';
import { parseDocMeta } from './markdown-meta.js';

// 文書・フォルダ操作(FR-DOC / 設計03章)
// - ファイル書き込みはアトミック(一時ファイル→rename。NFR-AVL-03)
// - 各操作はGitコミット(設計06章6.2の規約)とインデックス更新を伴う
// - フロントマターはサーバーが管理: クライアントはtagsのみ編集し、
//   未知キー(Obsidianプラグイン由来等)は保全する(FR-OBS-07)

export class DocNotFoundError extends Error {
  constructor(relPath: string) {
    super(`文書が見つかりません: ${relPath}`);
    this.name = 'DocNotFoundError';
  }
}

export class DocConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocConflictError';
  }
}

// ファイルシステム禁止文字は全角等へ置換する(要件05章5.1)。
// 文字化け防止のためUnicodeエスケープで明示する
const FORBIDDEN_CHAR_MAP: Record<string, string> = {
  '/': '／', // /
  '\\': '＼', // \
  ':': '：', // :
  '*': '＊', // *
  '?': '？', // ?
  '"': '”', // ”
  '<': '＜', // <
  '>': '＞', // >
  '|': '｜', // |
};

// Windowsの予約デバイス名(本番稼働環境がWindowsのため必須)
const WINDOWS_RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function sanitizeTitle(title: string): string {
  const replaced = [...title.normalize('NFC')]
    .map((c) => FORBIDDEN_CHAR_MAP[c] ?? c)
    .join('')
    .trim();
  // 制御文字・先頭ドット(隠しファイル化)・末尾のドットと空白(Windows制約)を除去
  let cleaned = replaced
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (WINDOWS_RESERVED_RE.test(cleaned)) {
    cleaned += '_';
  }
  if (!cleaned) {
    throw new InvalidPathError(title);
  }
  return cleaned;
}

// ローカルタイムゾーンのオフセット付きISO 8601(要件05章の例示形式)
function localIso(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const offAbs = Math.abs(off);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.trunc(offAbs / 60))}:${p(offAbs % 60)}`
  );
}

// フロントマターブロック(開始〜終了フェンス)の抽出用
const FM_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export class DocService {
  constructor(
    private readonly db: AppDatabase,
    private readonly config: AppConfig,
    private readonly git: GitService,
    private readonly indexer: IndexerService,
    private readonly logger?: Logger,
  ) {}

  // Gitコミット失敗はエラーにしない: ディスクが正本であり保存自体は完了している。
  // 未コミット差分は外部変更syncジョブ(設計06章6.4)が回収する
  private async tryCommit(paths: string[], message: string, author: GitAuthor): Promise<void> {
    try {
      await this.git.commit(paths, message, author);
    } catch (e) {
      this.logger?.error({ err: e, message }, 'Gitコミットに失敗しました(保存自体は完了)');
    }
  }

  private get libraryPath(): string {
    return this.config.libraryPath;
  }

  // 文書パスとして妥当か検証して正規化する(保護パス・拡張子)
  private validateDocPath(relPath: string): string {
    const normalized = normalizeRelPath(relPath);
    if (!normalized || isProtectedPath(normalized) || normalized.split('/').includes('.trash')) {
      throw new InvalidPathError(relPath);
    }
    if (!normalized.toLowerCase().endsWith('.md')) {
      throw new InvalidPathError(relPath);
    }
    return normalized;
  }

  private validateFolderPath(relPath: string): string {
    const normalized = normalizeRelPath(relPath);
    if (!normalized || isProtectedPath(normalized) || normalized.split('/').includes('.trash')) {
      throw new InvalidPathError(relPath);
    }
    return normalized;
  }

  // アトミック書き込み: 同一ディレクトリの一時ファイルに書いてからrename
  private async writeAtomic(abs: string, content: string): Promise<void> {
    const tmp = path.join(
      path.dirname(abs),
      `.tsumiwiki-tmp-${randomBytes(6).toString('hex')}`,
    );
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, abs);
  }

  // ---- ツリー ----

  async getTree(): Promise<TreeResponse> {
    const folders: string[] = [];
    await this.walkFolders('', folders);
    const docs = this.db
      .prepare('SELECT doc_path, title, folder, updated_at FROM doc_index ORDER BY folder, title')
      .all()
      .map((r) => {
        const row = r as { doc_path: string; title: string; folder: string; updated_at: string };
        return {
          path: row.doc_path,
          title: row.title,
          folder: row.folder,
          updatedAt: row.updated_at,
        } satisfies DocSummary;
      });
    return { folders: folders.sort(), docs };
  }

  private async walkFolders(relDir: string, out: string[]): Promise<void> {
    const absDir = relDir ? resolveInLibrary(this.libraryPath, relDir) : this.libraryPath;
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name.normalize('NFC');
      const rel = relDir ? `${relDir}/${name}` : name;
      if (isProtectedPath(rel) || name === '.trash') continue;
      out.push(rel);
      await this.walkFolders(rel, out);
    }
  }

  // ---- 文書 ----

  async getDoc(relPath: string): Promise<DocResponse> {
    const normalized = this.validateDocPath(relPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    let content: string;
    let mtime: Date;
    try {
      const st = await stat(abs);
      mtime = st.mtime;
      content = await readFile(abs, 'utf8');
    } catch {
      throw new DocNotFoundError(normalized);
    }

    let frontmatter: Record<string, unknown> = {};
    let body = content;
    try {
      const parsed = matter(content);
      frontmatter = parsed.data as Record<string, unknown>;
      body = parsed.content;
    } catch {
      // 壊れたフロントマターは空扱い(本文は全文を返す)
    }
    const meta = parseDocMeta(content);
    return {
      path: normalized,
      frontmatter,
      tags: meta.frontmatterTags,
      body,
      updatedAt: mtime.toISOString(),
    };
  }

  async createDoc(folder: string, title: string, author: GitAuthor): Promise<{ path: string; updatedAt: string }> {
    const folderNorm = folder ? this.validateFolderPath(folder) : '';
    const base = sanitizeTitle(title);
    const absFolder = folderNorm ? resolveInLibrary(this.libraryPath, folderNorm) : this.libraryPath;
    await mkdir(absFolder, { recursive: true });

    // 同名衝突時は「タイトル (2).md」形式で連番を付ける
    let fileName = `${base}.md`;
    for (let i = 2; await this.exists(path.join(absFolder, fileName)); i++) {
      fileName = `${base} (${i}).md`;
    }
    const relPath = folderNorm ? `${folderNorm}/${fileName}` : fileName;
    const abs = path.join(absFolder, fileName);

    const now = localIso();
    const content = `---\ncreated: ${now}\nupdated: ${now}\n---\n\n`;
    await this.writeAtomic(abs, content);
    await this.tryCommit([relPath], `add: ${relPath}`, author);
    await this.indexer.indexFile(relPath);
    const st = await stat(abs);
    return { path: relPath, updatedAt: st.mtime.toISOString() };
  }

  async saveDoc(
    relPath: string,
    body: string,
    tags: string[] | undefined,
    baseUpdatedAt: string,
    author: GitAuthor,
  ): Promise<{ updatedAt: string }> {
    const normalized = this.validateDocPath(relPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);

    let current: string;
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(abs);
      current = await readFile(abs, 'utf8');
    } catch {
      throw new DocNotFoundError(normalized);
    }
    // 競合検知: 取得時点のupdatedAtと現在のmtimeが一致しなければ拒否(設計03章)
    if (st.mtime.toISOString() !== baseUpdatedAt) {
      throw new DocConflictError(
        'この文書は取得後に変更されています。内容を退避してから再読み込みしてください',
      );
    }

    // 保存はLFに統一する(NFR-COMP-03。CRLF文書も保存時にLF化する)
    const content = this.composeContent(current, body, tags).replace(/\r\n/g, '\n');
    await this.writeAtomic(abs, content);
    await this.tryCommit([normalized], `edit: ${normalized}`, author);
    await this.indexer.indexFile(normalized);
    const after = await stat(abs);
    return { updatedAt: after.mtime.toISOString() };
  }

  // フロントマターの再結合(外科的編集)。yamlのDocument APIで tags / updated
  // ノードだけを差し替え、他キー・コメント・キー順・スタイルは原文のまま保持する
  // (FR-OBS-07。gray-matterでの再直列化はコメント脱落等の無関係な差分を生むため)
  private composeContent(current: string, body: string, tags: string[] | undefined): string {
    const normalizedTags = tags
      ?.map((t) => t.trim().replace(/^#/, '').normalize('NFC'))
      .filter(Boolean);

    const fmMatch = FM_BLOCK_RE.exec(current);
    if (!fmMatch) {
      // 元々フロントマターがない文書には不要なフロントマターを付けない
      if (!normalizedTags || normalizedTags.length === 0) return body;
      if (/^---\r?\n/.test(body)) {
        // 未終端フロントマター等、解釈の割れる文書にはFMを追加しない(二重化防止)
        this.logger?.warn('フロントマターの構造が不明なためタグ更新をスキップしました');
        return body;
      }
      const fm = yamlStringify({ tags: normalizedTags, updated: localIso() });
      return `---\n${fm}---\n\n${body.replace(/^\n/, '')}`;
    }

    const doc = parseYamlDocument(fmMatch[1]);
    if (doc.errors.length > 0) {
      // 壊れたフロントマターには触らない(本文のみ更新。タグ変更は反映しない)
      this.logger?.warn(
        { errors: doc.errors.map((e) => e.message) },
        '壊れたフロントマターのためタグ更新をスキップしました',
      );
      return body.startsWith('---')
        ? body
        : current.slice(0, fmMatch[0].length) + body.replace(/^\n/, '');
    }
    if (normalizedTags !== undefined) {
      if (normalizedTags.length > 0) doc.set('tags', normalizedTags);
      else doc.delete('tags');
    }
    doc.set('updated', localIso());
    return `---\n${doc.toString()}---\n${body}`;
  }

  async deleteDoc(relPath: string, author: GitAuthor): Promise<void> {
    const normalized = this.validateDocPath(relPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    if (!(await this.exists(abs))) {
      throw new DocNotFoundError(normalized);
    }
    const trashDir = path.join(this.libraryPath, '.trash');
    await mkdir(trashDir, { recursive: true });

    // ごみ箱内の同名衝突は連番で回避
    const baseName = path.posix.basename(normalized);
    let trashName = baseName;
    for (let i = 2; await this.exists(path.join(trashDir, trashName)); i++) {
      const ext = path.posix.extname(baseName);
      trashName = `${baseName.slice(0, baseName.length - ext.length)} (${i})${ext}`;
    }
    await rename(abs, path.join(trashDir, trashName));
    // スコープコミット: 無関係な外部変更を巻き込まない(それらはsyncが拾う)
    await this.tryCommit([normalized, `.trash/${trashName}`], `trash: ${normalized}`, author);
    this.indexer.removeFile(normalized);
  }

  async moveDoc(
    relPath: string,
    newFolder: string,
    newTitle: string,
    author: GitAuthor,
  ): Promise<{ path: string }> {
    const oldNorm = this.validateDocPath(relPath);
    const oldAbs = resolveInLibrary(this.libraryPath, oldNorm);
    if (!(await this.exists(oldAbs))) {
      throw new DocNotFoundError(oldNorm);
    }
    const folderNorm = newFolder ? this.validateFolderPath(newFolder) : '';
    const fileName = `${sanitizeTitle(newTitle)}.md`;
    const newNorm = folderNorm ? `${folderNorm}/${fileName}` : fileName;
    if (newNorm === oldNorm) {
      return { path: oldNorm };
    }
    const newAbs = resolveInLibrary(this.libraryPath, newNorm);
    // 大文字小文字のみの変更は、case-insensitiveなFS(Windows/macOS)では
    // existsが自分自身を指してしまうため、衝突チェックを行わずrenameに通す
    const caseOnly = newNorm.toLowerCase() === oldNorm.toLowerCase();
    if (!caseOnly && (await this.exists(newAbs))) {
      throw new DocConflictError(`移動先に同名の文書があります: ${newNorm}`);
    }
    await mkdir(path.dirname(newAbs), { recursive: true });
    await rename(oldAbs, newAbs);
    await this.tryCommit([oldNorm, newNorm], `move: ${oldNorm} -> ${newNorm}`, author);
    await this.indexer.moveFile(oldNorm, newNorm);
    return { path: newNorm };
  }

  // ---- フォルダ ----

  async createFolder(relPath: string): Promise<void> {
    const normalized = this.validateFolderPath(relPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    try {
      await mkdir(abs, { recursive: true });
    } catch (e) {
      const code = (e as { code?: string }).code;
      // 同名ファイルが存在する等
      if (code === 'EEXIST' || code === 'ENOTDIR') {
        throw new InvalidPathError(relPath);
      }
      throw e;
    }
    // 空フォルダはGit管理外(コミットは文書が置かれたときに発生する)
  }

  async moveFolder(relPath: string, newRelPath: string, author: GitAuthor): Promise<void> {
    const oldNorm = this.validateFolderPath(relPath);
    const newNorm = this.validateFolderPath(newRelPath);
    if (newNorm === oldNorm) return;
    // 自分自身の配下への移動は不可(existsより先に判定する)
    if (newNorm.startsWith(`${oldNorm}/`)) {
      throw new InvalidPathError(newRelPath);
    }
    const oldAbs = resolveInLibrary(this.libraryPath, oldNorm);
    const newAbs = resolveInLibrary(this.libraryPath, newNorm);
    if (!(await this.exists(oldAbs))) {
      throw new DocNotFoundError(oldNorm);
    }
    const caseOnly = newNorm.toLowerCase() === oldNorm.toLowerCase();
    if (!caseOnly && (await this.exists(newAbs))) {
      throw new DocConflictError(`移動先に同名のフォルダがあります: ${newNorm}`);
    }
    await mkdir(path.dirname(newAbs), { recursive: true });
    await rename(oldAbs, newAbs);
    await this.tryCommit([oldNorm, newNorm], `move: ${oldNorm}/ -> ${newNorm}/`, author);
    // 配下の全文書のパスが変わるため差分走査で付け替える
    await this.indexer.scanAll();
  }

  async deleteFolder(relPath: string, author: GitAuthor): Promise<void> {
    const normalized = this.validateFolderPath(relPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    if (!(await this.exists(abs))) {
      throw new DocNotFoundError(normalized);
    }
    const trashDir = path.join(this.libraryPath, '.trash');
    await mkdir(trashDir, { recursive: true });
    const baseName = path.posix.basename(normalized);
    let trashName = baseName;
    for (let i = 2; await this.exists(path.join(trashDir, trashName)); i++) {
      trashName = `${baseName} (${i})`;
    }
    await rename(abs, path.join(trashDir, trashName));
    await this.tryCommit([normalized, `.trash/${trashName}`], `trash: ${normalized}/`, author);
    await this.indexer.scanAll();
  }

  private async exists(abs: string): Promise<boolean> {
    try {
      await stat(abs);
      return true;
    } catch {
      return false;
    }
  }
}
