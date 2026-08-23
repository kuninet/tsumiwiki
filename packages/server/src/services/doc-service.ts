import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import matter from 'gray-matter';
import type { Logger } from 'pino';
import { parseDocument as parseYamlDocument, stringify as yamlStringify } from 'yaml';
import { REV_PATTERN } from '@tsumiwiki/shared';
import type { TrashEntry } from '@tsumiwiki/shared';
import type { DocResponse, DocSummary, RenameAttachmentResponse, TreeResponse } from '@tsumiwiki/shared';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import { ATTACHMENT_EXTENSIONS, isIndexedFileName } from '../lib/attachments.js';
import { InvalidPathError, isProtectedPath, normalizeRelPath, resolveInLibrary } from '../lib/paths.js';
import type { DraftService } from './draft-service.js';
import type { GitAuthor, GitService } from './git-service.js';
import type { IndexerService } from './indexer-service.js';
import { DocLockedError, type LockService } from './lock-service.js';
import { parseDocMeta } from './markdown-meta.js';

// 文書・フォルダ操作(FR-DOC / 設計03章)
// - ファイル書き込みはアトミック(一時ファイル→rename。NFR-AVL-03)
// - 各操作はGitコミット(設計06章6.2の規約)とインデックス更新を伴う
// - フロントマターはサーバーが管理: クライアントはtagsのみ編集し、
//   未知キー(Obsidianプラグイン由来等)は保全する(FR-OBS-07)

// .trashに置かれたフォルダの由来メタデータ。空フォルダ削除だとgitに載る差分が
// なくコミット→git log経由の由来復元が効かないため、フォルダのごみ箱には常に
// この名前のファイルを書き込んで由来を保持する
const TRASH_META_FILE = '.tsumiwiki-trash.json';

interface TrashMeta {
  originalPath: string;
  deletedAt: string;
  deletedBy: string;
}

// 3 フィールドすべての型を厳密に検証する。ゆるめだと deletedAt が null で UI 側の
// Date パースが落ちる等の 2 次事故につながる(#86 fix-forward)
function isTrashMeta(v: unknown): v is TrashMeta {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.originalPath === 'string' &&
    typeof o.deletedAt === 'string' &&
    typeof o.deletedBy === 'string'
  );
}

async function readTrashMeta(folderAbs: string): Promise<TrashMeta | null> {
  try {
    const raw = await readFile(path.join(folderAbs, TRASH_META_FILE), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isTrashMeta(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

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

// 添付ファイル名の検証(issue #199)。sanitizeTitleと異なり禁止文字を置換せず拒否する。
// リネームで「意図しない名前に化ける」事故(例: `/`が全角化されて別名で作られる)を
// 避けるため。NFC正規化・前後空白除去のみ行い、以降は不正なら例外。
function validateAttachmentName(name: string): string {
  const normalized = name.normalize('NFC').trim();
  if (!normalized) throw new InvalidPathError(name, 'ファイル名を入力してください');
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new InvalidPathError(name, 'ファイル名に制御文字は使えません');
  }
  if ([...normalized].some((c) => FORBIDDEN_CHAR_MAP[c] !== undefined)) {
    throw new InvalidPathError(name, 'ファイル名に / \\ : * ? " < > | は使えません');
  }
  // Markdown/Obsidian記法上の意味を持つ文字も拒否する(issue #199 再レビュー中B)。
  // 例: `a#b.png`は`![[a#b.png]]`で`#`以降がアンカー扱いになり埋め込みが解決不能になる、
  // `]`・`(`・`)`・バッククォート入りはWIKILINK_REWRITE_RE/MD_LINK_REWRITE_REで
  // targetとして捕捉できず、以後の参照検出・リネーム対象から外れてしまう。
  // 既存ファイルの表示・添付索引解決には影響しない(「この名前へ変更する」操作だけを拒否する)
  if (/[#[\]()`]/.test(normalized)) {
    throw new InvalidPathError(name, 'ファイル名に # [ ] ( ) ` は使えません(リンク記法と衝突するため)');
  }
  if (normalized.startsWith('.') || /[. ]$/.test(normalized)) {
    throw new InvalidPathError(name, 'ファイル名の先頭の . や末尾の . / 空白は使えません');
  }
  // 多くのファイルシステムはファイル名をUTF-8で255byteまでしか扱えない(NFR-COMP-04)
  if (Buffer.byteLength(normalized, 'utf8') > 255) {
    throw new InvalidPathError(name, 'ファイル名が長すぎます');
  }
  const ext = path.posix.extname(normalized);
  const stem = ext ? normalized.slice(0, normalized.length - ext.length) : normalized;
  if (WINDOWS_RESERVED_RE.test(stem)) {
    throw new InvalidPathError(name, 'Windows の予約名(CON, PRN, AUX, NUL, COM1〜9, LPT1〜9)は使えません');
  }
  return normalized;
}

// フロントマターブロックと本文を厳密に分離する(FM_BLOCK_RE。#199の参照書き換えで、
// フロントマターに一切触れず本文のみをバイト単位で書き戻すために使う)
function splitFrontmatter(content: string): { prefix: string; body: string } {
  const m = FM_BLOCK_RE.exec(content);
  return m ? { prefix: m[0], body: content.slice(m[0].length) } : { prefix: '', body: content };
}

// #199: リネーム時の参照検出・書き換えの両方が使う正規表現。target部分だけを差し替えられる
// よう、前後(記法の枠・alias・anchor・title)を別グループに分離して捕捉する
// (グループ順は「開き記法・target・閉じ記法」で隙間なく連結しているため、
// targetの開始位置はマッチ全体のindex + 開き記法の長さで正確に求まる)。
// 対象: Obsidian埋め込み `![[target]]`・wikilink `[[target]]`(`|alias`・`#anchor`は除く)、
// Markdown画像 `![alt](target)`・リンク `[text](target)`(`"title"`は除く)。
// http(s)/data/mailto/fileスキームは除外。target の `?`/`#` 以降は落とす。URLデコードはしない。
// `<...>` 囲みのリンクは対象外。単一行のtarget想定で改行含みには当たらない。
// コードブロック・インラインコードの内側(中2)はcomputeCodeRangesで除外する
const WIKILINK_REWRITE_RE = /(!?\[\[)([^\]|#\n]+?)((?:[#|][^\]\n]*)?\]\])/g;
const MD_LINK_REWRITE_RE = /(!?\[[^\]\n]*\]\()([^)\s\n]+)((?:\s+["'][^)\n]*)?\))/g;
const EXCLUDED_SCHEME_RE = /^(https?|data|mailto|file):/i;

// フェンス行(3文字以上の```/~~~連。インデントのみのコードブロックは対象外)の検出。
// markdown-meta.tsのstripCode(タグ抽出用)と同じ簡易な行単位の状態機械を、
// 位置(文字インデックス)を保った形で使うためにここでも定義する
const CODE_FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;
// インラインコード(`...`・``...``等)。バッククォート連長が一致するスパンを1行内で検出
const INLINE_CODE_SPAN_RE = /(`+).*?\1/g;

// body中の「コードブロック・インラインコードの内側」の文字範囲([start, end))を返す(中2)。
// extractLinkTargets/rewriteAttachmentReferencesはこの範囲内のtargetを対象外にする
function computeCodeRanges(body: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let offset = 0;
  let fence: { char: string; len: number } | null = null;
  for (const line of body.match(/[^\n]*\n|[^\n]+/g) ?? []) {
    const eolLen = line.endsWith('\r\n') ? 2 : line.endsWith('\n') ? 1 : 0;
    const bare = eolLen ? line.slice(0, -eolLen) : line;
    const fenceMatch = CODE_FENCE_LINE_RE.exec(bare);
    if (fence) {
      ranges.push({ start: offset, end: offset + line.length });
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.char &&
        fenceMatch[1].length >= fence.len &&
        /^\s*$/.test(bare.slice(fenceMatch[0].length))
      ) {
        fence = null;
      }
    } else if (fenceMatch) {
      fence = { char: fenceMatch[1][0], len: fenceMatch[1].length };
      ranges.push({ start: offset, end: offset + line.length });
    } else {
      for (const m of bare.matchAll(INLINE_CODE_SPAN_RE)) {
        ranges.push({ start: offset + (m.index ?? 0), end: offset + (m.index ?? 0) + m[0].length });
      }
    }
    offset += line.length;
  }
  return ranges;
}

function isWithinCode(ranges: { start: number; end: number }[], index: number): boolean {
  return ranges.some((r) => index >= r.start && index < r.end);
}

// targetの`?`/`#`以降(クエリ・アンカー)を切り離す。前後空白はtrimする(軽微8。
// `![[ old.png ]]`のような余白付きtargetも一致判定できるように抽出側・書き換え側で揃える)
function splitTargetSuffix(rawTarget: string): { pathPart: string; suffix: string } {
  const trimmed = rawTarget.trim();
  const cut = trimmed.search(/[?#]/);
  return cut === -1
    ? { pathPart: trimmed, suffix: '' }
    : { pathPart: trimmed.slice(0, cut), suffix: trimmed.slice(cut) };
}

// #199: リネーム時の参照検出対象を抽出する純関数。既存extractAttachmentFilenames
// (同フォルダ限定・拡張子限定)と異なり対象を絞らず、target文字列(スキーム付きURL等も含め)
// をそのまま返す。呼び出し側がindexer.resolveAttachmentで実ファイルへの一致を判定する
export function extractLinkTargets(body: string): string[] {
  const ranges = computeCodeRanges(body);
  const result = new Set<string>();
  const consider = (m: RegExpMatchArray) => {
    const offset = (m.index ?? 0) + m[1].length;
    if (isWithinCode(ranges, offset)) return;
    const { pathPart } = splitTargetSuffix(m[2]);
    if (!pathPart) return;
    if (EXCLUDED_SCHEME_RE.test(pathPart)) return;
    result.add(pathPart);
  };
  for (const m of body.matchAll(WIKILINK_REWRITE_RE)) consider(m);
  for (const m of body.matchAll(MD_LINK_REWRITE_RE)) consider(m);
  return [...result];
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

// #159: 文書本文が同フォルダに置いた画像添付を参照している「bareファイル名」を抽出する。
// Obsidian embed `![[X]]`(`|alias`・`#anchor` は捨てる)とマークダウン画像 `![alt](X)`
// (`"title"` は捨てる)を対象。http(s)/data スキームやフォルダ区切りを含むターゲットは
// 対象外(同フォルダ添付に限定)。単一行 URL 想定で改行含みには当たらない。
// TODO(#160): 保存先モード拡張時に、集約フォルダを指す絶対パス参照も対象化するか再検討
const OBSIDIAN_EMBED_RE = /!\[\[([^\]|#\n]+?)(?:[#|][^\]\n]*)?\]\]/g;
const MARKDOWN_IMG_RE = /!\[[^\]\n]*\]\(([^)\s\n]+)(?:\s+["'][^)\n]*)?\)/g;

function extractAttachmentFilenames(
  body: string,
  extensions: ReadonlySet<string>,
): string[] {
  const result = new Set<string>();
  const consider = (raw: string) => {
    const target = raw.trim();
    if (!target) return;
    if (/^(https?:|data:)/i.test(target)) return;
    if (target.includes('/')) return;
    // クエリ・フラグメントは拡張子判定前に落とす(ローカルファイル参照は通常付かないが保険)
    const clean = target.split(/[?#]/)[0];
    const dot = clean.lastIndexOf('.');
    if (dot < 0) return;
    const ext = clean.slice(dot).toLowerCase();
    if (!extensions.has(ext)) return;
    result.add(clean);
  };
  for (const m of body.matchAll(OBSIDIAN_EMBED_RE)) consider(m[1]);
  for (const m of body.matchAll(MARKDOWN_IMG_RE)) consider(m[1]);
  return [...result];
}

// 他文書本文にファイル名リテラルが「独立した」トークンとして現れるかを判定する。
// 素朴な substring 一致だと `1.png` が `image-1.png` にヒットしてしまう(false-shared)
// ため、直前は英数・`_`・`-`・`.`・`/` 以外、直後は英数・`_`・`-`・`.` 以外を要求する。
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function referencesFilename(content: string, filename: string): boolean {
  const re = new RegExp(
    `(?:^|[^\\w\\-./])${escapeRegex(filename)}(?![\\w\\-.])`,
    'u',
  );
  return re.test(content);
}

export class DocService {
  constructor(
    private readonly db: AppDatabase,
    private readonly config: AppConfig,
    private readonly git: GitService,
    private readonly indexer: IndexerService,
    private readonly locks: LockService,
    private readonly drafts: DraftService,
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

  // 索引の更新はbest-effort: 失敗しても呼び出し元の後続処理(コミット後のロック・
  // 下書きのrepath等)は必ず継続する。索引はキャッシュであり、次回のscanAll・
  // 外部変更sync(設計06章6.4)で整合が回復するため(文書・添付・フォルダ共通。issue #203)
  private async tryUpdateIndex(
    op: () => Promise<unknown>,
    context: Record<string, unknown>,
    what: string,
  ): Promise<void> {
    try {
      await op();
    } catch (e) {
      this.logger?.warn({ err: e, ...context }, `${what}の索引更新に失敗しました(次回走査で回復)`);
    }
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

  // 排他的な新規作成: 既存ファイルがあればfalse(上書きしない)。
  // linkはrenameと違い既存パスでEEXISTになるため、連番決定のTOCTOUを防げる
  private async writeExclusive(abs: string, content: Buffer): Promise<boolean> {
    const tmp = path.join(path.dirname(abs), `.tsumiwiki-tmp-${randomBytes(6).toString('hex')}`);
    await writeFile(tmp, content);
    try {
      await link(tmp, abs);
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'EEXIST') return false;
      throw e;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  // アトミック書き込み: 同一ディレクトリの一時ファイルに書いてからrename
  private async writeAtomic(abs: string, content: string | Buffer): Promise<void> {
    const tmp = path.join(
      path.dirname(abs),
      `.tsumiwiki-tmp-${randomBytes(6).toString('hex')}`,
    );
    await writeFile(tmp, content);
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
    const lock = this.locks.getActive(normalized);
    return {
      path: normalized,
      frontmatter,
      tags: meta.frontmatterTags,
      body,
      updatedAt: mtime.toISOString(),
      lock: lock ? { userId: lock.userId, displayName: lock.displayName } : null,
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
    await this.tryUpdateIndex(() => this.indexer.indexFile(relPath), { relPath }, '文書');
    const st = await stat(abs);
    return { path: relPath, updatedAt: st.mtime.toISOString() };
  }

  // #84 Phase 2 デイリーノート・テンプレ流し込み用に、指定パスに任意本文で新規作成する。
  // 既に存在する場合は EEXIST 相当のエラー(呼び出し側で「存在確認→なければ作成」の分岐)。
  // 通常の createDoc(自動連番)と違い、パスは呼び出し側で確定させる前提。
  async createDocWithContent(
    relPath: string,
    content: string,
    author: GitAuthor,
  ): Promise<{ path: string; updatedAt: string }> {
    const normalized = this.validateDocPath(relPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    await mkdir(path.dirname(abs), { recursive: true });
    // LF 統一 + 末尾改行(NFR-COMP-03。他の書き込みパスに合わせる)
    const normalizedContent = content.replace(/\r\n/g, '\n');
    const finalContent = normalizedContent.endsWith('\n') ? normalizedContent : `${normalizedContent}\n`;
    const buf = Buffer.from(finalContent, 'utf8');
    // writeExclusive は既存でEEXIST。連番は付けずそのまま「衝突」として上位に伝える
    // (呼び出し側でレース時のフォールバック=既存の再取得ができるように InvalidPath でなく Conflict)
    const ok = await this.writeExclusive(abs, buf);
    if (!ok) {
      throw new DocConflictError(`既に存在します: ${normalized}`);
    }
    await this.tryCommit([normalized], `add: ${normalized}`, author);
    await this.tryUpdateIndex(() => this.indexer.indexFile(normalized), { path: normalized }, '文書');
    const st = await stat(abs);
    return { path: normalized, updatedAt: st.mtime.toISOString() };
  }

  async saveDoc(
    relPath: string,
    body: string,
    tags: string[] | undefined,
    baseUpdatedAt: string,
    userId: number,
    author: GitAuthor,
  ): Promise<{ updatedAt: string }> {
    const normalized = this.validateDocPath(relPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    // 保存はロック保持者のみ(FR-LOCK-01/02。#22計画の結合点をここで解決)
    this.locks.assertHeldBy(normalized, userId);

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
    await this.tryUpdateIndex(() => this.indexer.indexFile(normalized), { path: normalized }, '文書');
    // 明示保存に成功したら本人の下書きは不要になる(FR-EDIT-08)
    this.drafts.removeOwn(normalized, userId);
    const after = await stat(abs);
    return { updatedAt: after.mtime.toISOString() };
  }

  // MCP経由の保存(issue #190)。呼び出しユーザーの概念がないため、UI編集ロックの
  // 保持は要求しない代わりに、誰かが有効なロックを保持中(=UIで編集中)なら拒否する
  // (MCPからの上書きで進行中の編集を潰さないための安全策)。下書き削除も行わない。
  async saveDocMcp(
    relPath: string,
    body: string,
    tags: string[] | undefined,
    baseUpdatedAt: string,
    author: GitAuthor,
  ): Promise<{ updatedAt: string }> {
    const normalized = this.validateDocPath(relPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    const lock = this.locks.getActive(normalized);
    if (lock) throw new DocLockedError(lock);

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
    await this.tryUpdateIndex(() => this.indexer.indexFile(normalized), { path: normalized }, '文書');
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

  async deleteDoc(relPath: string, userId: number, author: GitAuthor): Promise<void> {
    const normalized = this.validateDocPath(relPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    if (!(await this.exists(abs))) {
      throw new DocNotFoundError(normalized);
    }
    // 他ユーザーが編集中の文書は削除できない(編集中削除の事故防止)
    this.locks.assertNotLockedByOther(normalized, userId);
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
    await this.tryUpdateIndex(async () => this.indexer.removeFile(normalized), { path: normalized }, '文書');
    this.locks.forceRelease(normalized);
    this.drafts.removeAll(normalized);
  }

  async moveDoc(
    relPath: string,
    newFolder: string,
    newTitle: string,
    userId: number,
    author: GitAuthor,
  ): Promise<{ path: string }> {
    const oldNorm = this.validateDocPath(relPath);
    const oldAbs = resolveInLibrary(this.libraryPath, oldNorm);
    if (!(await this.exists(oldAbs))) {
      throw new DocNotFoundError(oldNorm);
    }
    this.locks.assertNotLockedByOther(oldNorm, userId);
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

    // #159: フォルダ跨ぎの移動時、この文書が同フォルダに置いた画像添付のうち
    // 他文書から一切参照されていないもの(=専属)を一緒に運ぶ。他文書が参照して
    // いる可能性のあるものは他方のリンク維持を優先して現地に残す。
    // 大文字小文字のみの折衝(case-only)は case-insensitive FS で self-exists にぶつかる
    // ため、フォルダ実体は同一とみなして添付走査自体をスキップする。
    const oldFolder =
      path.posix.dirname(oldNorm) === '.' ? '' : path.posix.dirname(oldNorm);
    const folderChanged =
      folderNorm !== oldFolder &&
      folderNorm.toLowerCase() !== oldFolder.toLowerCase();
    const attachmentMoves: {
      oldRel: string;
      newRel: string;
      oldAbs: string;
      newAbs: string;
    }[] = [];
    if (folderChanged) {
      try {
        const oldContent = await readFile(oldAbs, 'utf8');
        const { body } = parseDocMeta(oldContent);
        const candidates = extractAttachmentFilenames(body, DocService.ATTACHMENT_EXTENSIONS);
        const exclusive = await this.findExclusiveAttachments(oldFolder, candidates, oldNorm);
        for (const filename of exclusive) {
          const attOldRel = oldFolder ? `${oldFolder}/${filename}` : filename;
          const attNewRel = folderNorm ? `${folderNorm}/${filename}` : filename;
          const attOldAbs = resolveInLibrary(this.libraryPath, attOldRel);
          const attNewAbs = resolveInLibrary(this.libraryPath, attNewRel);
          // 移動先に同名添付がある場合は誤上書き回避で現地に残す
          if (await this.exists(attNewAbs)) continue;
          attachmentMoves.push({
            oldRel: attOldRel,
            newRel: attNewRel,
            oldAbs: attOldAbs,
            newAbs: attNewAbs,
          });
        }
      } catch (e) {
        // 添付走査は best-effort。失敗しても文書自体の移動は継続する
        this.logger?.warn({ err: e, docPath: oldNorm }, '添付の同伴走査に失敗しました');
      }
    }

    await mkdir(path.dirname(newAbs), { recursive: true });
    await rename(oldAbs, newAbs);
    const commitPaths: string[] = [oldNorm, newNorm];
    const movedAttachments: typeof attachmentMoves = [];
    for (const m of attachmentMoves) {
      try {
        await rename(m.oldAbs, m.newAbs);
        movedAttachments.push(m);
        commitPaths.push(m.oldRel, m.newRel);
      } catch (e) {
        // 添付の rename が失敗するとリンクが切れる。move 全体をロールバックして
        // 「一部だけ移動して壊れた状態」を残さない。
        this.logger?.error(
          { err: e, docPath: oldNorm, from: m.oldRel, to: m.newRel },
          '添付の移動に失敗したため、文書移動をロールバックします',
        );
        for (const done of movedAttachments) {
          try {
            await rename(done.newAbs, done.oldAbs);
          } catch (rbErr) {
            this.logger?.error(
              { err: rbErr, from: done.newAbs, to: done.oldAbs },
              '添付のロールバックに失敗しました(手動復旧が必要)',
            );
          }
        }
        try {
          await rename(newAbs, oldAbs);
        } catch (rbErr) {
          this.logger?.error(
            { err: rbErr, from: newAbs, to: oldAbs },
            '文書のロールバックに失敗しました(手動復旧が必要)',
          );
        }
        throw new Error(`添付の移動に失敗したため文書移動を中止しました: ${m.oldRel}`);
      }
    }
    await this.tryCommit(commitPaths, `move: ${oldNorm} -> ${newNorm}`, author);
    await this.tryUpdateIndex(
      () => this.indexer.moveFile(oldNorm, newNorm),
      { oldPath: oldNorm, newPath: newNorm },
      '文書',
    );
    // 同伴した添付も索引を付け替える(issue #198。#159の添付同伴に追随)
    for (const m of movedAttachments) {
      await this.tryUpdateIndex(
        () => this.indexer.moveAttachment(m.oldRel, m.newRel),
        { oldRel: m.oldRel, newRel: m.newRel },
        '添付',
      );
    }
    // ロック・下書きも新パスへ追随させる
    this.locks.repath(oldNorm, newNorm);
    this.drafts.repath(oldNorm, newNorm);
    return { path: newNorm };
  }

  // 指定文書の同フォルダ画像添付のうち、他文書から一切参照されていないもの(専属)を返す。
  // 判定は referencesFilename(境界チェック付き)で他 .md 本文を走査する近似で、誤って
  // 共有扱いとする方向へ倒す(現地に残す)ことで他文書のリンク切れを防ぐ。
  // TODO(#160含む): 大規模ライブラリでは N-1 件 readFile が高コスト。将来、doc_index に
  // 添付参照リストを持たせて O(1) 逆引きに置き換える。
  private async findExclusiveAttachments(
    sourceFolder: string,
    candidateFilenames: string[],
    excludeDocPath: string,
  ): Promise<string[]> {
    if (candidateFilenames.length === 0) return [];
    const shared = new Set<string>();
    const otherDocs = (
      this.db
        .prepare('SELECT doc_path FROM doc_index WHERE doc_path != ?')
        .all(excludeDocPath) as { doc_path: string }[]
    ).map((r) => r.doc_path);

    for (const docPath of otherDocs) {
      if (shared.size === candidateFilenames.length) break;
      let content: string;
      try {
        const abs = resolveInLibrary(this.libraryPath, docPath);
        content = await readFile(abs, 'utf8');
      } catch {
        // 読めない .md は共有判定できないが、安全側=現地に残す方向に倒れるためスキップ
        continue;
      }
      for (const filename of candidateFilenames) {
        if (shared.has(filename)) continue;
        if (referencesFilename(content, filename)) shared.add(filename);
      }
    }

    const exclusive: string[] = [];
    for (const filename of candidateFilenames) {
      if (shared.has(filename)) continue;
      const rel = sourceFolder ? `${sourceFolder}/${filename}` : filename;
      const abs = resolveInLibrary(this.libraryPath, rel);
      if (await this.exists(abs)) exclusive.push(filename);
    }
    return exclusive;
  }

  // ---- 添付(FR-IMG / FR-OBS-05) ----

  // 添付として受け付ける拡張子(画像のみ。PDF等はFR-IMG-04=COULDで将来)
  // 定義はlib/attachments.tsに集約(indexer-serviceと共有するため)
  static readonly ATTACHMENT_EXTENSIONS = ATTACHMENT_EXTENSIONS;

  // 画像添付の保存(FR-IMG-01/02)。保存先は既定で文書と同じフォルダ、
  // 設定(ATTACHMENT_DIR_MODE)でフォルダ名指定も可能
  async addAttachment(
    docPath: string,
    originalName: string,
    data: Buffer,
    author: GitAuthor,
  ): Promise<{ fileName: string; path: string }> {
    const docNorm = this.validateDocPath(docPath);
    if (!(await this.exists(resolveInLibrary(this.libraryPath, docNorm)))) {
      throw new DocNotFoundError(docNorm);
    }
    const ext = path.posix.extname(originalName.normalize('NFC')).toLowerCase();
    if (!DocService.ATTACHMENT_EXTENSIONS.has(ext)) {
      throw new InvalidPathError(originalName);
    }

    const mode = this.config.attachmentDirMode;
    const dirRel = mode === 'same-folder' ? path.posix.dirname(docNorm) : mode;
    const dirNorm = dirRel === '.' ? '' : dirRel;
    const absDir = dirNorm ? resolveInLibrary(this.libraryPath, dirNorm) : this.libraryPath;
    await mkdir(absDir, { recursive: true });

    // image-YYYYMMDDHHmmss形式+衝突時は連番(要件05章5.1)
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    let fileName = `image-${stamp}${ext}`;
    for (let i = 2; !(await this.writeExclusive(path.join(absDir, fileName), data)); i++) {
      fileName = `image-${stamp}-${i}${ext}`;
    }
    const relPath = dirNorm ? `${dirNorm}/${fileName}` : fileName;
    await this.tryCommit([relPath], `attach: ${relPath}`, author);
    // 添付索引に即時反映(issue #198。/api/embedで直後から解決できるように)
    await this.tryUpdateIndex(() => this.indexer.indexAttachment(relPath), { relPath }, '添付');
    return { fileName, path: relPath };
  }

  // 添付パスとして妥当か検証して正規化する(保護パス・.trash・.md・非画像拡張子を拒否。issue #199)
  private validateAttachmentPath(relPath: string): string {
    const normalized = normalizeRelPath(relPath);
    if (!normalized || isProtectedPath(normalized) || normalized.split('/').includes('.trash')) {
      throw new InvalidPathError(relPath);
    }
    if (normalized.toLowerCase().endsWith('.md')) {
      throw new InvalidPathError(relPath);
    }
    const ext = path.posix.extname(normalized).toLowerCase();
    if (!DocService.ATTACHMENT_EXTENSIONS.has(ext)) {
      throw new InvalidPathError(relPath);
    }
    return normalized;
  }

  // 指定添付を参照している文書のパス一覧(issue #199)。findExclusiveAttachmentsと同じ
  // O(N)読み込み方針(全doc_indexを読む)。ライブラリ規模が大きい場合のコスト対策は
  // TODO(#160含む)を参照(将来doc_indexに添付参照リストを持たせるなどして解消する)
  async findAttachmentReferences(attachmentRelPath: string): Promise<string[]> {
    const normalized = this.validateAttachmentPath(attachmentRelPath);
    const docs = (
      this.db.prepare('SELECT doc_path FROM doc_index').all() as { doc_path: string }[]
    ).map((r) => r.doc_path);

    const result: string[] = [];
    for (const docPath of docs) {
      let content: string;
      try {
        content = await readFile(resolveInLibrary(this.libraryPath, docPath), 'utf8');
      } catch {
        continue;
      }
      const { body } = splitFrontmatter(content);
      for (const target of extractLinkTargets(body)) {
        if (this.indexer.resolveAttachment(target, docPath) === normalized) {
          result.push(docPath);
          break;
        }
      }
    }
    return result;
  }

  // 文書本文中の添付参照のうち、basenameがoldBasenameと一致(大文字小文字無視)し
  // resolveAttachmentで対象添付そのものに解決されるものだけをnewBasenameへ置換する。
  // フォルダ部分・alias・anchor・titleは保持し、コードブロック・インラインコードの内側は
  // 対象外にする(中2)。実際に置換したtarget(from/to。API契約)も合わせて返す
  private rewriteAttachmentReferences(
    body: string,
    docPath: string,
    oldBasename: string,
    newBasename: string,
    attachmentRelPath: string,
  ): { body: string; replacements: { from: string; to: string }[] } {
    const oldLower = oldBasename.toLowerCase();
    const replacements = new Map<string, string>();

    const rewriteTarget = (rawTarget: string): string | null => {
      const { pathPart, suffix } = splitTargetSuffix(rawTarget);
      if (!pathPart || EXCLUDED_SCHEME_RE.test(pathPart)) return null;
      const slashIdx = pathPart.lastIndexOf('/');
      const base = slashIdx === -1 ? pathPart : pathPart.slice(slashIdx + 1);
      if (base.toLowerCase() !== oldLower) return null;
      if (this.indexer.resolveAttachment(pathPart, docPath) !== attachmentRelPath) return null;
      const folderPrefix = slashIdx === -1 ? '' : pathPart.slice(0, slashIdx + 1);
      const newPathPart = `${folderPrefix}${newBasename}`;
      replacements.set(pathPart, newPathPart);
      return `${newPathPart}${suffix}`;
    };
    // codeRangesは各パス実行時点のbodyに対して都度算出する(1つ目のreplaceで文字数が
    // 変わるため、2つ目のreplace時に古いrangesを使うとインデックスがずれてしまう)
    const makeReplacer = (ranges: { start: number; end: number }[]) => {
      return (full: string, open: string, target: string, close: string, offset: number): string => {
        if (isWithinCode(ranges, offset + open.length)) return full;
        const replaced = rewriteTarget(target);
        return replaced === null ? full : `${open}${replaced}${close}`;
      };
    };
    let working = body.replace(WIKILINK_REWRITE_RE, makeReplacer(computeCodeRanges(body)));
    working = working.replace(MD_LINK_REWRITE_RE, makeReplacer(computeCodeRanges(working)));

    return { body: working, replacements: [...replacements].map(([from, to]) => ({ from, to })) };
  }

  // 添付ファイルの名前変更(issue #199)。参照している全文書のリンクを1コミットで書き換える
  async renameAttachment(
    relPath: string,
    newName: string,
    author: GitAuthor,
  ): Promise<RenameAttachmentResponse> {
    const normalized = this.validateAttachmentPath(relPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    if (!(await this.exists(abs))) {
      throw new DocNotFoundError(normalized);
    }

    let candidateName = validateAttachmentName(newName);
    const oldExt = path.posix.extname(normalized).toLowerCase();
    let candidateExt = path.posix.extname(candidateName).toLowerCase();
    if (!candidateExt) {
      // 拡張子省略時は元の拡張子を補う
      candidateName = `${candidateName}${path.posix.extname(normalized)}`;
      candidateExt = oldExt;
    }
    if (candidateExt !== oldExt) {
      // 画像形式の変更はしない
      throw new InvalidPathError(newName, `拡張子は ${oldExt} のまま変更できません`);
    }

    const dir = path.posix.dirname(normalized);
    const dirPrefix = dir === '.' ? '' : dir;
    const newNorm = dirPrefix ? `${dirPrefix}/${candidateName}` : candidateName;

    if (newNorm === normalized) {
      return { path: normalized, name: path.posix.basename(normalized), rewrittenDocs: [] };
    }
    const newAbs = resolveInLibrary(this.libraryPath, newNorm);
    // 大文字小文字のみの変更は、case-insensitiveなFS(Windows/macOS)ではexistsが
    // 自分自身を指してしまうため、衝突チェックを行わない(moveDocと同じ方針)
    const caseOnly = newNorm.toLowerCase() === normalized.toLowerCase();
    if (!caseOnly && (await this.exists(newAbs))) {
      throw new DocConflictError(`同名のファイルがあります: ${newNorm}`);
    }

    // 参照文書の書き換え+添付本体のrenameを1つのtry/catchにまとめる。どちらの段階で
    // 失敗しても、書き換え済み文書とrename済みの添付ファイル名を元に戻してから例外を投げる
    // (moveDocの添付ロールバックと同じ流儀。中3)
    const oldBasename = path.posix.basename(normalized);
    const references = await this.findAttachmentReferences(normalized);
    const rewrittenDocs: { path: string; updatedAt: string; replacements: { from: string; to: string }[] }[] =
      [];
    const backups: { docPath: string; docAbs: string; content: string }[] = [];
    // caseOnly時、一時名への退避が完了した(=元に戻す必要がある)かどうか
    let renamedToTmp = false;
    let tmpAbs = '';
    try {
      for (const docPath of references) {
        const docAbs = resolveInLibrary(this.libraryPath, docPath);
        const original = await readFile(docAbs, 'utf8');
        const { prefix, body } = splitFrontmatter(original);
        const { body: rewrittenBody, replacements } = this.rewriteAttachmentReferences(
          body,
          docPath,
          oldBasename,
          candidateName,
          normalized,
        );
        if (rewrittenBody === body) continue;
        backups.push({ docPath, docAbs, content: original });
        // 改行コードは保持する(CRLF→LF変換はしない。saveDocとは方針が異なる点に注意)
        await this.writeAtomic(docAbs, prefix + rewrittenBody);
        const st = await stat(docAbs);
        rewrittenDocs.push({ path: docPath, updatedAt: st.mtime.toISOString(), replacements });
      }

      // ファイル本体のrename(case-insensitive FS対応: 大文字小文字のみの変更は一時名を経由する)
      if (caseOnly) {
        tmpAbs = path.join(path.dirname(abs), `.tsumiwiki-tmp-${randomBytes(6).toString('hex')}`);
        await rename(abs, tmpAbs);
        renamedToTmp = true;
        await rename(tmpAbs, newAbs);
        renamedToTmp = false;
      } else {
        await rename(abs, newAbs);
      }
    } catch (e) {
      if (renamedToTmp) {
        try {
          await rename(tmpAbs, abs);
        } catch (rbErr) {
          this.logger?.error(
            { err: rbErr, tmpAbs, abs },
            '添付renameのロールバックに失敗しました(手動復旧が必要)',
          );
        }
      }
      for (const b of backups) {
        try {
          await this.writeAtomic(b.docAbs, b.content);
        } catch (rbErr) {
          this.logger?.error(
            { err: rbErr, docPath: b.docPath },
            '参照書き換えのロールバックに失敗しました(手動復旧が必要)',
          );
        }
      }
      throw e;
    }

    await this.tryCommit(
      [normalized, newNorm, ...rewrittenDocs.map((d) => d.path)],
      `rename attachment: ${normalized} -> ${newNorm}`,
      author,
    );
    await this.tryUpdateIndex(
      () => this.indexer.moveAttachment(normalized, newNorm),
      { oldRel: normalized, newRel: newNorm },
      '添付',
    );
    // 書き換えた文書の索引も更新する
    for (const d of rewrittenDocs) {
      await this.tryUpdateIndex(() => this.indexer.indexFile(d.path), { docPath: d.path }, '文書');
    }

    return { path: newNorm, name: candidateName, rewrittenDocs };
  }

  // 添付ファイルの削除(issue #199)。ごみ箱送りのみで、参照文書は書き換えない
  // (Obsidianと同じ挙動。表示は404→失敗チップになる)
  async deleteAttachment(relPath: string, author: GitAuthor): Promise<void> {
    const normalized = this.validateAttachmentPath(relPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    if (!(await this.exists(abs))) {
      throw new DocNotFoundError(normalized);
    }
    const trashDir = path.join(this.libraryPath, '.trash');
    await mkdir(trashDir, { recursive: true });

    // ごみ箱内の同名衝突は連番で回避(deleteDocと同じ規則)
    const baseName = path.posix.basename(normalized);
    let trashName = baseName;
    for (let i = 2; await this.exists(path.join(trashDir, trashName)); i++) {
      const ext = path.posix.extname(baseName);
      trashName = `${baseName.slice(0, baseName.length - ext.length)} (${i})${ext}`;
    }
    await rename(abs, path.join(trashDir, trashName));
    await this.tryCommit([normalized, `.trash/${trashName}`], `trash: ${normalized}`, author);
    await this.tryUpdateIndex(
      async () => this.indexer.removeAttachment(normalized),
      { relPath: normalized },
      '添付',
    );
  }

  // ---- ごみ箱(FR-DOC-07) ----

  // .trash直下の項目パスとして検証する(ネスト・脱出は拒否)
  private validateTrashLeaf(relPath: string): string {
    const normalized = normalizeRelPath(relPath);
    if (!/^\.trash\/[^/]+$/.test(normalized)) {
      throw new InvalidPathError(relPath);
    }
    return normalized;
  }

  async listTrash(): Promise<TrashEntry[]> {
    const trashDir = path.join(this.libraryPath, '.trash');
    let entries;
    try {
      entries = await readdir(trashDir, { withFileTypes: true });
    } catch {
      return []; // .trash未作成
    }
    // 削除者・削除日時・元パスの取得方針:
    // - フォルダは `.trash/<name>/.tsumiwiki-trash.json` の由来メタデータを最優先で読む
    //   (空フォルダ削除でgitに差分が乗らずgit log経由の復元が効かない対策)
    // - ファイル、またはメタデータ不在時は trash: コミットからの復元にフォールバック
    // - 項目単位で並列取得し、1項目のGitエラーで一覧全体を落とさない
    const result: TrashEntry[] = await Promise.all(
      entries.map(async (entry) => {
        const name = entry.name.normalize('NFC');
        const trashPath = `.trash/${name}`;
        const isFolder = entry.isDirectory();
        if (isFolder) {
          const meta = await readTrashMeta(path.join(trashDir, name));
          if (meta) {
            return {
              trashPath,
              name,
              isFolder,
              originalPath: meta.originalPath,
              deletedAt: meta.deletedAt,
              deletedBy: meta.deletedBy,
            };
          }
        }
        let commit = null;
        try {
          commit = await this.git.lastCommitFor(trashPath);
        } catch (e) {
          this.logger?.warn({ err: e, trashPath }, 'ごみ箱項目の由来取得に失敗しました');
        }
        const m = commit?.message.match(/^trash: (.+?)\/?$/);
        return {
          trashPath,
          name,
          isFolder,
          originalPath: m ? m[1] : null,
          deletedAt: commit?.date ?? null,
          deletedBy: commit?.authorName ?? null,
        };
      }),
    );
    // 削除日時の新しい順
    return result.sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  }

  // ごみ箱から元の場所へ復元する(FR-DOC-07)。元パスに同名があれば連番を付ける
  async restoreFromTrash(trashPath: string, author: GitAuthor): Promise<{ path: string }> {
    const normalized = this.validateTrashLeaf(trashPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    let isFolder: boolean;
    try {
      isFolder = (await stat(abs)).isDirectory();
    } catch {
      throw new DocNotFoundError(normalized);
    }

    // フォルダは由来メタデータを最優先で読む(空フォルダ削除の対策。上記listTrashと同方針)
    let original: string | null = null;
    if (isFolder) {
      const meta = await readTrashMeta(abs);
      if (meta) original = meta.originalPath;
    }
    if (!original) {
      // ファイル、またはメタデータ不在時は trash: コミットからの復元にフォールバック
      let commit = null;
      try {
        commit = await this.git.lastCommitFor(normalized);
      } catch (e) {
        this.logger?.warn({ err: e, trashPath: normalized }, 'ごみ箱項目の由来取得に失敗しました');
      }
      const m = commit?.message.match(/^trash: (.+?)\/?$/);
      // 元パス不明(手動で.trashに置かれた等)ならルート直下へ戻す
      original = m ? m[1] : path.posix.basename(normalized);
    }

    // 元パスが不正(..等の細工コミット)な場合もbasenameへフォールバックする
    // (先にnormalizeで例外を出すと復元不能になるため、正規化はtryで包む)
    let dest: string;
    try {
      dest = normalizeRelPath(original);
    } catch {
      dest = path.posix.basename(normalized);
    }
    if (!dest || isProtectedPath(dest) || dest.split('/').includes('.trash')) {
      dest = path.posix.basename(normalized);
    }
    // 復元先の衝突は連番で回避(existsチェック→renameの間の競合は
    // 実運用頻度が低く許容。Gitコミット自体は直列キューで保護される)
    const ext = isFolder ? '' : path.posix.extname(dest);
    const stem = ext ? dest.slice(0, dest.length - ext.length) : dest;
    for (let i = 2; await this.exists(resolveInLibrary(this.libraryPath, dest)); i++) {
      dest = `${stem} (${i})${ext}`;
    }

    const destAbs = resolveInLibrary(this.libraryPath, dest);
    await mkdir(path.dirname(destAbs), { recursive: true });
    await rename(abs, destAbs);
    // フォルダ復元時は「TsumiWikiが書き込んだ」メタデータのみ削除する。
    // ユーザーが独自に置いた同名ファイル(有効なTrashMeta形式でない)は破壊しない(#86 fix-forward)
    if (isFolder) {
      const metaAbs = path.join(destAbs, TRASH_META_FILE);
      const existing = await readTrashMeta(destAbs);
      if (existing) {
        try {
          await rm(metaAbs, { force: true });
        } catch (e) {
          this.logger?.warn(
            { err: e, dest },
            'trashメタデータの後片付けに失敗しました(復元自体は完了)',
          );
        }
      }
    }
    await this.tryCommit([normalized, dest], `untrash: ${dest}${isFolder ? '/' : ''}`, author);
    if (isFolder) {
      await this.tryUpdateIndex(() => this.indexer.scanAll(), { dest }, 'フォルダ配下の全走査');
    } else if (dest.toLowerCase().endsWith('.md')) {
      await this.tryUpdateIndex(() => this.indexer.indexFile(dest), { path: dest }, '文書');
    } else if (isIndexedFileName(dest)) {
      await this.tryUpdateIndex(() => this.indexer.indexAttachment(dest), { dest }, '添付');
    }
    return { path: dest };
  }

  // ごみ箱からの完全削除(admin専用。ファイルは消えるがGit履歴には残る)
  async purgeTrash(trashPath: string, author: GitAuthor): Promise<void> {
    const normalized = this.validateTrashLeaf(trashPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    if (!(await this.exists(abs))) {
      throw new DocNotFoundError(normalized);
    }
    await rm(abs, { recursive: true, force: true });
    await this.tryCommit([normalized], `purge: ${normalized}`, author);
  }

  // ---- 履歴(FR-HIST) ----

  async history(relPath: string) {
    const normalized = this.validateDocPath(relPath);
    return this.git.history(normalized);
  }

  // ライブラリ全体の履歴(issue #66)。パス指定がないためvalidateDocPathは不要
  async historyAll(limit?: number) {
    return this.git.historyAll(limit);
  }

  // rev形式の防御的検証(呼び出し元のスキーマ検証に依存しない)
  private assertRev(rev: string): void {
    if (!REV_PATTERN.test(rev)) {
      throw new InvalidPathError(rev);
    }
  }

  // 「版・パスの不在」を示すGitエラーか(それ以外はインフラ障害として扱う)
  private isRevNotFound(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    return /unknown revision|does not exist|bad revision|invalid object name|bad object|fatal: path/i.test(
      msg,
    );
  }

  // 過去版の内容。存在しない版・パスはDocNotFoundError、それ以外の障害は再throw
  async contentAt(relPath: string, rev: string): Promise<string> {
    const normalized = this.validateDocPath(relPath);
    this.assertRev(rev);
    try {
      return await this.git.contentAt(rev, normalized);
    } catch (e) {
      if (this.isRevNotFound(e)) {
        throw new DocNotFoundError(`${normalized} @${rev.slice(0, 7)}`);
      }
      this.logger?.error({ err: e, rev, path: normalized }, '過去版の取得に失敗しました');
      throw e;
    }
  }

  // 全体履歴用: そのコミット単体で加わった差分(rev^..rev)を任意パスに対して返す。
  // 全体履歴は .gitignore・.trash 配下・添付ファイル等の非文書パスも含みうるため、
  // validateDocPath の拡張子・保護パス制約を掛けず、パス正規化のみで扱う(issue #66)
  async diffCommitForAnyPath(relPath: string, rev: string): Promise<string> {
    const normalized = normalizeRelPath(relPath);
    if (!normalized) throw new InvalidPathError(relPath);
    this.assertRev(rev);
    try {
      return await this.git.diff(`${rev}^`, rev, normalized);
    } catch (e) {
      if (this.isRevNotFound(e)) {
        throw new DocNotFoundError(`${normalized} @${rev.slice(0, 7)}`);
      }
      this.logger?.error({ err: e, rev, path: normalized }, 'コミット差分の取得に失敗しました');
      throw e;
    }
  }

  // 2版間の差分。against省略時は現行版(HEAD)と比較(FR-HIST-03)
  async diffVersions(relPath: string, rev: string, against?: string): Promise<string> {
    const normalized = this.validateDocPath(relPath);
    this.assertRev(rev);
    if (against !== undefined) this.assertRev(against);
    try {
      return await this.git.diff(rev, against ?? 'HEAD', normalized);
    } catch (e) {
      if (this.isRevNotFound(e)) {
        throw new DocNotFoundError(
          `${normalized} @${rev.slice(0, 7)}${against ? `..${against.slice(0, 7)}` : ''}`,
        );
      }
      this.logger?.error({ err: e, rev, against, path: normalized }, '差分の取得に失敗しました');
      throw e;
    }
  }

  // 過去版の内容で上書き保存する。履歴は改変せず新しいコミットとして記録
  // (FR-HIST-04)。編集ロックの保持が前提(設計03章)。
  // 注意: 復元は「意図的な上書き」のためbaseUpdatedAt競合検知は行わない。
  // また履歴内容をバイト厳密に書き戻すため、saveDocのLF統一・updated更新は適用しない
  async restoreDoc(
    relPath: string,
    rev: string,
    userId: number,
    author: GitAuthor,
  ): Promise<{ updatedAt: string }> {
    const normalized = this.validateDocPath(relPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    this.assertRev(rev);
    this.locks.assertHeldBy(normalized, userId);
    const content = await this.contentAt(normalized, rev);
    await this.writeAtomic(abs, content);
    await this.tryCommit([normalized], `restore: ${normalized} @${rev.slice(0, 7)}`, author);
    await this.tryUpdateIndex(() => this.indexer.indexFile(normalized), { path: normalized }, '文書');
    this.drafts.removeOwn(normalized, userId);
    const after = await stat(abs);
    return { updatedAt: after.mtime.toISOString() };
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

  async moveFolder(
    relPath: string,
    newRelPath: string,
    userId: number,
    author: GitAuthor,
  ): Promise<{ path: string }> {
    const oldNorm = this.validateFolderPath(relPath);
    const newNorm = this.validateFolderPath(newRelPath);
    if (newNorm === oldNorm) return { path: oldNorm };
    this.locks.assertFolderNotLockedByOther(oldNorm, userId);
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
    await this.tryUpdateIndex(
      () => this.indexer.scanAll(),
      { oldPath: oldNorm, newPath: newNorm },
      'フォルダ配下の全走査',
    );
    this.locks.repathFolder(oldNorm, newNorm);
    this.drafts.repathFolder(oldNorm, newNorm);
    return { path: newNorm };
  }

  async deleteFolder(relPath: string, userId: number, author: GitAuthor): Promise<void> {
    const normalized = this.validateFolderPath(relPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    if (!(await this.exists(abs))) {
      throw new DocNotFoundError(normalized);
    }
    this.locks.assertFolderNotLockedByOther(normalized, userId);
    const trashDir = path.join(this.libraryPath, '.trash');
    await mkdir(trashDir, { recursive: true });
    const baseName = path.posix.basename(normalized);
    let trashName = baseName;
    for (let i = 2; await this.exists(path.join(trashDir, trashName)); i++) {
      trashName = `${baseName} (${i})`;
    }
    const trashFolderAbs = path.join(trashDir, trashName);
    await rename(abs, trashFolderAbs);
    // 由来メタデータを書き込む(空フォルダでも由来を失わないように。空だと gitに載る差分が
    // 発生せず trash: コミットが出来ないためgit log経由の復元が効かない問題への対処)
    const meta: TrashMeta = {
      originalPath: normalized,
      deletedAt: new Date().toISOString(),
      deletedBy: author.name,
    };
    await writeFile(
      path.join(trashFolderAbs, TRASH_META_FILE),
      `${JSON.stringify(meta, null, 2)}\n`,
      'utf8',
    );
    await this.tryCommit([normalized, `.trash/${trashName}`], `trash: ${normalized}/`, author);
    await this.tryUpdateIndex(() => this.indexer.scanAll(), { path: normalized }, 'フォルダ配下の全走査');
    this.locks.removeUnder(normalized);
    this.drafts.removeUnder(normalized);
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
