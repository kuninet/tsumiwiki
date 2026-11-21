import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import matter from 'gray-matter';
import type { Logger } from 'pino';
import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  Pair,
  parseDocument as parseYamlDocument,
  stringify as yamlStringify,
  YAMLSeq,
} from 'yaml';
import {
  LIBRARY_SETTINGS_DEFAULTS,
  REV_PATTERN,
  attachmentSettingsFromEnv,
} from '@tsumiwiki/shared';
import type {
  AttachmentSummary,
  BacklinksResponse,
  DeleteDocResponse,
  DocResponse,
  DocSummary,
  FrontmatterOp,
  LibrarySettings,
  MoveDocRequest,
  MoveDocsBatchResponse,
  MovedDocResponse,
  RenameAttachmentResponse,
  ReorganizeExecuteResponse,
  ReorganizePreviewResponse,
  SaveDocResponse,
  SkippedAttachment,
  TrashEntry,
  TreeResponse,
} from '@tsumiwiki/shared';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import { ATTACHMENT_EXTENSIONS, isIndexedFileName } from '../lib/attachments.js';
import {
  EXCLUDED_SCHEME_RE,
  FM_BLOCK_RE,
  MD_LINK_REWRITE_RE,
  WIKILINK_REWRITE_RE,
  buildByNameIndex,
  extractLinkTargets,
  folderOfDoc,
  normalizeEmbedTarget,
  resolveAttachmentFromByName,
  resolveMarkdownRelPath,
  resolveShortestEmbedTargetWith,
  splitFrontmatter,
  splitTargetSuffix,
} from '../lib/attachment-links.js';
import { computeCodeRanges, isWithinCode } from '../lib/code-ranges.js';
import {
  InvalidPathError,
  isProtectedPath,
  normalizeRelPath,
  resolveInLibrary,
} from '../lib/paths.js';
import { planAttachmentReorganization, type ReorgInputDoc } from './attachment-reorganizer.js';
import type { DraftService } from './draft-service.js';
import type { GitAuthor, GitService } from './git-service.js';
import type { IndexerService } from './indexer-service.js';
import type { LibrarySettingsService } from './library-settings-service.js';
import { DocLockedError, type LockService } from './lock-service.js';
import { normalizeTagName, parseDocMeta, splitTagString } from './markdown-meta.js';
import { SerialQueue } from './serial-queue.js';
import { applyPatches, guardFrontmatter, type PatchEdit } from '../mcp/note-patch.js';

export { extractLinkTargets } from '../lib/attachment-links.js';

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

// #161: ごみ箱送りされた文書と同伴添付の由来を `.trash/.tsumiwiki-trash.json` に保持する。
// 既存の .gitignore で .tsumiwiki-trash.json が除外されているため Git 履歴には乗らない。
interface TrashCompanionAttachment {
  trashPath: string;
  originalPath: string;
}

interface TrashFileMeta extends TrashMeta {
  attachments?: TrashCompanionAttachment[];
}

interface TrashFileManifest {
  version: 1;
  items: Record<string, TrashFileMeta>;
}

function isTrashCompanionAttachment(v: unknown): v is TrashCompanionAttachment {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.trashPath === 'string' &&
    o.trashPath.length > 0 &&
    typeof o.originalPath === 'string' &&
    o.originalPath.length > 0
  );
}

function isTrashFileMeta(v: unknown): v is TrashFileMeta {
  if (!isTrashMeta(v)) return false;
  const o = v as unknown as Record<string, unknown>;
  if (o.attachments !== undefined) {
    if (!Array.isArray(o.attachments) || !o.attachments.every(isTrashCompanionAttachment)) {
      return false;
    }
  }
  return true;
}

function parseTrashFileManifest(raw: string): TrashFileManifest {
  const empty: TrashFileManifest = { version: 1, items: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    const o = parsed as Record<string, unknown>;
    if (o.version !== 1 || !o.items || typeof o.items !== 'object' || Array.isArray(o.items)) {
      return empty;
    }
    const items: Record<string, TrashFileMeta> = {};
    for (const [k, v] of Object.entries(o.items as Record<string, unknown>)) {
      if (!k || k.includes('/') || k === TRASH_META_FILE) continue;
      if (isTrashFileMeta(v)) {
        items[k.normalize('NFC')] = v;
      }
    }
    return { version: 1, items };
  } catch {
    return empty;
  }
}

const TRASH_ATTACHMENT_TRAILER_PREFIX = 'Trashed-Attachment: ';

function findCompanionInManifest(
  manifest: TrashFileManifest,
  trashPath: string,
): { docTrashName: string; docMeta: TrashFileMeta; att: TrashCompanionAttachment } | null {
  const target = trashPath.normalize('NFC');
  for (const [docTrashName, docMeta] of Object.entries(manifest.items)) {
    for (const att of docMeta.attachments ?? []) {
      if (att.trashPath.normalize('NFC') === target) {
        return { docTrashName, docMeta, att };
      }
    }
  }
  return null;
}

function removeCompanionPathFromManifest(
  manifest: TrashFileManifest,
  trashPath: string,
  existingTrashFileNames?: Set<string>,
): void {
  const target = trashPath.normalize('NFC');
  for (const [docTrashName, docMeta] of Object.entries(manifest.items)) {
    if (!docMeta.attachments?.length) continue;
    const filtered = docMeta.attachments.filter((a) => a.trashPath.normalize('NFC') !== target);
    if (filtered.length !== docMeta.attachments.length) {
      if (
        filtered.length === 0 &&
        existingTrashFileNames &&
        !existingTrashFileNames.has(docTrashName)
      ) {
        delete manifest.items[docTrashName];
      } else {
        docMeta.attachments = filtered;
      }
    }
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

export class FrontmatterUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontmatterUpdateError';
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
    throw new InvalidPathError(
      name,
      'ファイル名に # [ ] ( ) ` は使えません(リンク記法と衝突するため)',
    );
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
    throw new InvalidPathError(
      name,
      'Windows の予約名(CON, PRN, AUX, NUL, COM1〜9, LPT1〜9)は使えません',
    );
  }
  return normalized;
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

// 先頭のフロントマターブロックを除いた本文を返す。composeContent と同じ FM_BLOCK_RE で判定する
// (gray-matter とは閉じのない `---` や `...` 終端の扱いが異なるため、書き戻す経路ではこちらを使う)
function bodyAfterFrontmatter(content: string): string {
  const m = FM_BLOCK_RE.exec(content);
  return m ? content.slice(m[0].length) : content;
}

// タグの指定。配列は全置き換え、関数は「今のフロントマター tags → 新しい tags」の差分適用
// (update_frontmatter の addTags / removeTags。#292)
export type TagsUpdate = string[] | ((current: string[]) => string[]);

export interface TreeOptions {
  folder?: string;
  recursive?: boolean;
  foldersOnly?: boolean;
  includeAttachments?: boolean;
}

type YamlDoc = ReturnType<typeof parseYamlDocument>;

// tags 列の要素1個をタグとして読む。スカラーは原文の表記(`2026-01-01`・`true`・`1.0` 等)を
// そのまま使い、null と空文字は undefined(捨てる)。入れ子の列・マップ等はタグとして扱わない
function tagOfNode(item: unknown): string | undefined {
  if (!isScalar(item) || item.value === null || item.value === undefined) return undefined;
  const t = normalizeTagName(item.source ?? String(item.value));
  return t || undefined;
}

// yaml Document 上の今の tags を読み、update の結果で書き戻す(#292)。
// 読み取りと書き戻しを同じ Document で行い、パーサの解釈差でタグが消えないようにする。
// - tags が無ければ単数キー tag を読む(書き戻し先は常に tags。tag はそのまま残す)
// - 列の中の入れ子の列・マップ等は add/remove の対象外として元の位置に残す
// - 既存のスカラー要素は元のノードを残すため、表記は原文のまま
// - tags 直下の列はその場で書き換え、エイリアス・tag キー・文字列からは新しい列を作る
//   (tags 直下の列にアンカーが付いていれば、参照側まで変わるためエラーにする)
function applyTagsUpdateToDocument(doc: YamlDoc, update: (current: string[]) => string[]): void {
  // 索引(parseDocMeta の `tags ?? tag`)と同じく、tags が無いか空値なら tag を読む
  const isEmpty = (n: unknown) =>
    n === undefined || n === null || (isScalar(n) && n.value === null);
  const key = !isEmpty(doc.get('tags', true)) ? 'tags' : doc.has('tag') ? 'tag' : undefined;
  const raw: unknown = key ? doc.get(key, true) : undefined;
  const node: unknown = isAlias(raw) ? raw.resolve(doc) : raw;

  let target: YAMLSeq | undefined;
  let items: unknown[];
  if (isEmpty(node)) {
    items = [];
  } else if (isSeq(node)) {
    if (key === 'tags' && !isAlias(raw)) {
      if (node.anchor) {
        // 他のキーからエイリアスで参照されうる列は、書き換えると参照側まで変わるため触らない
        throw new FrontmatterUpdateError(
          'フロントマターの tags にアンカー(&)が付いているため、タグを追加・削除できません',
        );
      }
      target = node;
      items = [...node.items];
    } else {
      items = node.items.map((it) => (isNode(it) ? it.clone() : it));
    }
  } else if (isScalar(node)) {
    items =
      typeof node.value === 'string'
        ? splitTagString(node.value).map((t) => doc.createNode(t))
        : [node.clone()];
  } else {
    throw new FrontmatterUpdateError('フロントマターの tags をタグの並びとして解釈できません');
  }

  const current = items.map(tagOfNode).filter((t): t is string => t !== undefined);
  const next = update(current).map(normalizeTagName).filter(Boolean);
  const nextSet = new Set(next);
  const present = new Set(current);
  // スカラー要素は残すタグだけ元のノードのまま残し、タグとして読めない要素はそのまま残す
  const kept = items.filter((it) => {
    if (!isScalar(it)) return true;
    const t = tagOfNode(it);
    return t !== undefined && nextSet.has(t);
  });
  const added = [...nextSet].filter((t) => !present.has(t)).map((t) => doc.createNode(t));
  const result = [...kept, ...added];

  if (result.length === 0) {
    doc.delete('tags');
    return;
  }
  if (target) {
    target.items = result;
    return;
  }
  const seq = new YAMLSeq(doc.schema);
  seq.items = result;
  doc.set('tags', seq);
}

// MCP の直列化編集(追記・フロントマター更新)で、今の全文から決める書き戻し内容。
// strictFrontmatter が true なら、フロントマターが壊れているときはタグだけの指定でも
// FrontmatterUpdateError で拒否する(update_frontmatter 用。追記は従来どおり)
interface McpEditPlan {
  body: string;
  tags?: TagsUpdate;
  frontmatter?: Record<string, unknown>;
  strictFrontmatter?: boolean;
  // 指定時は composeContent と LF 統一を通さず、この内容をそのまま書く(履歴の復元用)
  rawContent?: string;
  // 指定時はこのメッセージでコミットする(既定は `edit: <path>`)
  commitMessage?: string;
}

const RESERVED_FM_KEYS = new Set(['tags', 'updated']);
const DANGEROUS_FM_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// フロントマター更新パッチの検証(issue #286)
export function validateFrontmatterPatch(
  patch?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!patch) return undefined;
  const normalized: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(patch)) {
    const key = rawKey.normalize('NFC');
    if (!key.trim()) {
      throw new FrontmatterUpdateError('フロントマターのキー名を空にすることはできません');
    }
    if (RESERVED_FM_KEYS.has(key)) {
      throw new FrontmatterUpdateError(`フロントマターの予約キー '${key}' は直接変更できません`);
    }
    if (DANGEROUS_FM_KEYS.has(key)) {
      throw new FrontmatterUpdateError(`フロントマターに危険なキー名 '${key}' は指定できません`);
    }
    normalized[key] = value;
  }
  return normalized;
}

// UI のプロパティ編集で触れないキー(#282)。tag は TagChipEditor が tags の代わりに読むため含める
const RESERVED_PROPERTY_OP_KEYS = new Set(['tags', 'tag', 'updated']);

// 操作のキー名を正規化・検証する。NFC 化と前後空白の除去を行い、空・予約・危険・制御文字を拒否する
function normalizeOpKey(raw: string): string {
  const key = raw.normalize('NFC').trim();
  if (!key) {
    throw new FrontmatterUpdateError('プロパティ名を空にすることはできません');
  }
  if (RESERVED_PROPERTY_OP_KEYS.has(key)) {
    throw new FrontmatterUpdateError(`プロパティ '${key}' はここでは変更できません`);
  }
  if (DANGEROUS_FM_KEYS.has(key)) {
    throw new FrontmatterUpdateError(`フロントマターに危険なキー名 '${key}' は指定できません`);
  }
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw new FrontmatterUpdateError('プロパティ名に改行や制御文字は使えません');
  }
  return key;
}

// キー文字列に一致する Pair を探す(#282)。スカラーのキーだけを対象に String(value) で比べる
// (gray-matter 経由のクライアントには 123: や true: のキーも文字列で届くため)
function findPair(doc: YamlDoc, key: string): Pair<unknown, unknown> | undefined {
  if (!isMap(doc.contents)) return undefined;
  return doc.contents.items.find(
    (p) => isScalar(p.key) && p.key.value !== null && String(p.key.value).normalize('NFC') === key,
  );
}

// 純関数: フロントマターの編集操作を適用する(#282)。YAML Document の既存ノードを外科的に書き換える
export function applyFrontmatterOps(doc: YamlDoc, ops: FrontmatterOp[]): void {
  if (!ops || ops.length === 0) return;

  // 1. 正規化・検証 (不正なキー名は即座にエラー)
  const normalizedOps = ops.map((op) => {
    if (op.op === 'set') {
      return { op: 'set' as const, key: normalizeOpKey(op.key), value: op.value };
    }
    if (op.op === 'delete') {
      return { op: 'delete' as const, key: normalizeOpKey(op.key) };
    }
    return {
      op: 'rename' as const,
      from: normalizeOpKey(op.from),
      to: normalizeOpKey(op.to),
    };
  });

  // 2. delete
  for (const op of normalizedOps) {
    if (op.op !== 'delete') continue;
    const pair = findPair(doc, op.key);
    if (!pair) continue;
    if (isNode(pair.value) && pair.value.anchor) {
      throw new FrontmatterUpdateError(
        `プロパティ '${op.key}' は他の場所から参照(&アンカー)されているため削除できません`,
      );
    }
    if (isMap(doc.contents)) {
      const idx = doc.contents.items.indexOf(pair);
      if (idx !== -1) {
        if (idx === 0 && isScalar(pair.key) && pair.key.commentBefore) {
          const moved = pair.key.commentBefore;
          if (doc.contents.items.length > 1) {
            const next = doc.contents.items[1];
            if (isNode(next.key)) {
              next.key.commentBefore = [moved, next.key.commentBefore].filter(Boolean).join('\n');
            }
          } else {
            doc.commentBefore = [moved, doc.commentBefore].filter(Boolean).join('\n');
          }
        }
        doc.contents.items.splice(idx, 1);
      }
    }
  }

  // 3. rename
  if (isMap(doc.contents)) {
    const renameOps = normalizedOps.filter(
      (op): op is { op: 'rename'; from: string; to: string } => op.op === 'rename',
    );
    const adopted: { pair: Pair<unknown, unknown>; from: string; to: string }[] = [];
    for (const rop of renameOps) {
      if (rop.from === rop.to) continue;
      const pair = findPair(doc, rop.from);
      if (!pair) continue;
      adopted.push({ pair, from: rop.from, to: rop.to });
    }

    if (adopted.length > 0) {
      const fromSet = new Set<string>();
      const toSet = new Set<string>();
      for (const item of adopted) {
        if (fromSet.has(item.from) || toSet.has(item.to)) {
          throw new FrontmatterUpdateError('プロパティ名が重複しています');
        }
        fromSet.add(item.from);
        toSet.add(item.to);
      }

      const currentKeys = doc.contents.items
        .map((p) =>
          isScalar(p.key) && p.key.value !== null ? String(p.key.value).normalize('NFC') : '',
        )
        .filter(Boolean);
      const remainingKeySet = new Set(currentKeys.filter((k) => !fromSet.has(k)));
      for (const item of adopted) {
        if (remainingKeySet.has(item.to)) {
          throw new FrontmatterUpdateError(`プロパティ '${item.to}' は既にあります`);
        }
        remainingKeySet.add(item.to);
      }

      for (const item of adopted) {
        if (isScalar(item.pair.key)) {
          item.pair.key.value = item.to;
        }
      }
    }
  }

  // 4. set
  for (const op of normalizedOps) {
    if (op.op !== 'set') continue;
    const pair = findPair(doc, op.key);
    if (!pair) {
      doc.set(op.key, op.value);
    } else {
      const node = pair.value;
      if (isNode(node) && node.anchor) {
        throw new FrontmatterUpdateError(
          `プロパティ '${op.key}' は他の場所から参照(&アンカー)されているため変更できません`,
        );
      }
      if (isAlias(node)) {
        pair.value = doc.createNode(op.value);
      } else if (Array.isArray(op.value) && isSeq(node)) {
        node.items = op.value.map((v) => doc.createNode(v));
      } else if (isScalar(node) && !Array.isArray(op.value)) {
        node.value = op.value;
      } else {
        pair.value = doc.createNode(op.value);
      }
    }
  }
}

// フロントマターの状態(#282)。書き込み側(composeContent)と同じ FM_BLOCK_RE と yaml で判定する
export function frontmatterStatusOf(content: string): 'ok' | 'none' | 'invalid' {
  // 先に空ブロックを判定する: /^---\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/
  if (/^---\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.test(content)) {
    return 'none';
  }
  const m = FM_BLOCK_RE.exec(content);
  if (!m) {
    return /^---\r?\n/.test(content) ? 'invalid' : 'none';
  }
  const parsed = parseYamlDocument(m[1]);
  if (parsed.errors.length > 0) {
    return 'invalid';
  }
  const json = parsed.toJSON();
  if (json === null || json === undefined) {
    return 'ok';
  }
  if (typeof json === 'object' && !Array.isArray(json)) {
    // マップのキーが空や null 等の不正なキーを持たないか確認
    if (isMap(parsed.contents)) {
      const hasInvalidKey = parsed.contents.items.some(
        (p) =>
          !isScalar(p.key) || p.key.value === null || !String(p.key.value).normalize('NFC').trim(),
      );
      if (hasInvalidKey) return 'invalid';
    }
    return 'ok';
  }
  return 'invalid';
}

// 本文先頭の YAML フロントマターを抽出し、ヘッダーを除去した本文とプロパティを分離する(issue #286)
export function extractLeadingFrontmatter(body: string): {
  body: string;
  frontmatter?: Record<string, unknown>;
  tags?: string[];
} {
  const m = FM_BLOCK_RE.exec(body);
  if (!m) {
    return { body };
  }

  try {
    const doc = parseYamlDocument(m[1]);
    if (doc.errors.length > 0) {
      return { body };
    }
    const json = doc.toJSON();
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      // ルートがマップでない(スカラーや配列)場合は本文として扱う(AT-10 水平線等)
      return { body };
    }

    const rawRecord = json as Record<string, unknown>;
    const frontmatter: Record<string, unknown> = {};
    let tags: string[] | undefined;

    for (const [k, v] of Object.entries(rawRecord)) {
      if (k === 'tags') {
        if (Array.isArray(v)) {
          tags = v.map((item) => String(item));
        } else if (typeof v === 'string') {
          tags = [v];
        }
      } else if (k !== 'updated') {
        frontmatter[k] = v;
      }
    }

    return {
      body: body.slice(m[0].length),
      frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : undefined,
      tags,
    };
  } catch {
    return { body };
  }
}

// 他文書本文にファイル名リテラルが「独立した」トークンとして現れるかを判定する(#159 / #334)。
// 素朴な substring 一致だと `1.png` が `image-1.png` にヒットしてしまう(false-shared)
// ため、直前は英数・`_`・`-`・`.`・`/` 以外、直後は英数・`_`・`-`・`.` 以外を要求する。
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function referencesFilename(content: string, filename: string): boolean {
  const re = new RegExp(`(?:^|[^\\w\\-.])${escapeRegex(filename)}(?![\\w\\-.])`, 'u');
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
    private readonly librarySettings?: LibrarySettingsService,
  ) {}

  // appendDocMcp のパスごとの直列化キュー(末尾の Promise)。完了時に自分が末尾なら削除する
  private readonly appendTails = new Map<string, Promise<unknown>>();
  // .trash/.tsumiwiki-trash.json の読み書き競合を防ぐ直列化キュー
  private readonly trashManifestQueue = new SerialQueue();

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
    const tmp = path.join(path.dirname(abs), `.tsumiwiki-tmp-${randomBytes(6).toString('hex')}`);
    await writeFile(tmp, content);
    await rename(tmp, abs);
  }

  // 一括整理等のテストで FS 失敗を注入できるよう rename をラップ
  private async moveFile(fromAbs: string, toAbs: string): Promise<void> {
    await rename(fromAbs, toAbs);
  }

  private reorgInFlight = false;

  // ---- ツリー ----

  async getTree(options: TreeOptions = {}): Promise<TreeResponse & { folder: string }> {
    const recursive = options.recursive ?? true;
    const folder = await this.resolveTreeFolder(options.folder ?? '');
    const folders: string[] = [];
    await this.walkFolders(folder, folders, recursive);
    const docs = options.foldersOnly ? [] : this.queryTreeDocs(folder, recursive);
    if (options.includeAttachments && !options.foldersOnly) {
      const attachments = this.queryTreeAttachments(folder, recursive);
      return { folder, folders: folders.sort(), docs, attachments };
    }
    return { folder, folders: folders.sort(), docs };
  }

  private async walkFolders(relDir: string, out: string[], recursive = true): Promise<void> {
    const absDir = relDir ? resolveInLibrary(this.libraryPath, relDir) : this.libraryPath;
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name.normalize('NFC');
      const rel = relDir ? `${relDir}/${name}` : name;
      if (isProtectedPath(rel) || name === '.trash') continue;
      out.push(rel);
      if (recursive) {
        await this.walkFolders(rel, out, recursive);
      }
    }
  }

  private async resolveTreeFolder(input: string): Promise<string> {
    const normalized = normalizeRelPath(input);
    if (!normalized) {
      return '';
    }
    // ルート以外: 保護パス(.で始まるセグメント)や .trash は拒否
    const parts = normalized.split('/');
    if (isProtectedPath(normalized) || parts.some((p) => p === '.trash' || p.startsWith('.'))) {
      throw new InvalidPathError(input);
    }

    // ディレクトリ存在確認
    const abs = resolveInLibrary(this.libraryPath, normalized);
    let s;
    try {
      s = await stat(abs);
    } catch {
      throw new DocNotFoundError(input);
    }
    if (!s.isDirectory()) {
      throw new DocNotFoundError(input);
    }

    // 大文字小文字の厳密一致確認（macOS対策）: 階層ごとに readdir して NFC 厳密一致を確認
    let currentRel = '';
    for (const seg of parts) {
      const currentAbs = currentRel
        ? resolveInLibrary(this.libraryPath, currentRel)
        : this.libraryPath;
      const dirEntries = await readdir(currentAbs);
      const matched = dirEntries.some((e) => e.normalize('NFC') === seg);
      if (!matched) {
        throw new DocNotFoundError(input);
      }
      currentRel = currentRel ? `${currentRel}/${seg}` : seg;
    }

    return normalized;
  }

  private queryTreeDocs(folder: string, recursive: boolean): DocSummary[] {
    let rows: unknown[];
    if (folder === '') {
      if (recursive) {
        rows = this.db
          .prepare(
            'SELECT doc_path, title, folder, updated_at FROM doc_index ORDER BY folder, title',
          )
          .all();
      } else {
        rows = this.db
          .prepare(
            "SELECT doc_path, title, folder, updated_at FROM doc_index WHERE folder = '' ORDER BY folder, title",
          )
          .all();
      }
    } else {
      if (recursive) {
        rows = this.db
          .prepare(
            'SELECT doc_path, title, folder, updated_at FROM doc_index WHERE folder = @f OR substr(folder, 1, length(@p)) = @p ORDER BY folder, title',
          )
          .all({ f: folder, p: `${folder}/` });
      } else {
        rows = this.db
          .prepare(
            'SELECT doc_path, title, folder, updated_at FROM doc_index WHERE folder = ? ORDER BY folder, title',
          )
          .all(folder);
      }
    }

    return rows.map((r) => {
      const row = r as { doc_path: string; title: string; folder: string; updated_at: string };
      return {
        path: row.doc_path,
        title: row.title,
        folder: row.folder,
        updatedAt: row.updated_at,
      } satisfies DocSummary;
    });
  }

  // attachment_index からツリー表示用の添付ファイル一覧を取得する(#318)。
  // LIKE ワイルドカード(% や _)による誤一致を避けるため queryTreeDocs と同じく substr で判定する
  private queryTreeAttachments(folder: string, recursive: boolean): AttachmentSummary[] {
    let rows: unknown[];
    if (folder === '') {
      if (recursive) {
        rows = this.db
          .prepare(
            'SELECT rel_path, name, folder, updated_at FROM attachment_index ORDER BY folder, name',
          )
          .all();
      } else {
        rows = this.db
          .prepare(
            "SELECT rel_path, name, folder, updated_at FROM attachment_index WHERE folder = '' ORDER BY folder, name",
          )
          .all();
      }
    } else {
      if (recursive) {
        rows = this.db
          .prepare(
            'SELECT rel_path, name, folder, updated_at FROM attachment_index WHERE folder = @f OR substr(folder, 1, length(@p)) = @p ORDER BY folder, name',
          )
          .all({ f: folder, p: `${folder}/` });
      } else {
        rows = this.db
          .prepare(
            'SELECT rel_path, name, folder, updated_at FROM attachment_index WHERE folder = ? ORDER BY folder, name',
          )
          .all(folder);
      }
    }

    return rows.map((r) => {
      const row = r as { rel_path: string; name: string; folder: string; updated_at: string };
      return {
        path: row.rel_path,
        name: row.name,
        folder: row.folder,
        updatedAt: row.updated_at,
      } satisfies AttachmentSummary;
    });
  }

  // ---- 文書 ----

  // フロントマターのパース(壊れたYAMLやトップレベル配列/スカラーは空オブジェクト扱い)
  private parseFrontmatterData(content: string): Record<string, unknown> {
    try {
      const parsed = matter(content);
      if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
        return parsed.data as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

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

    const frontmatter = this.parseFrontmatterData(content);
    const frontmatterStatus = frontmatterStatusOf(content);
    let body = content;
    try {
      body = matter(content).content;
    } catch {
      // 壊れたフロントマターは空扱い(本文は全文を返す)
    }
    const meta = parseDocMeta(content);
    const lock = this.locks.getActive(normalized);
    return {
      path: normalized,
      frontmatter,
      frontmatterStatus,
      tags: meta.frontmatterTags,
      body,
      updatedAt: mtime.toISOString(),
      lock: lock ? { userId: lock.userId, displayName: lock.displayName } : null,
    };
  }

  // 指定文書へのバックリンク一覧を取得する(#267)
  async getBacklinks(relPath: string, options?: { limit?: number }): Promise<BacklinksResponse> {
    const normalized = this.validateDocPath(relPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    try {
      await stat(abs);
    } catch {
      throw new DocNotFoundError(normalized);
    }
    return this.indexer.findBacklinks(normalized, options);
  }

  async createDoc(
    folder: string,
    title: string,
    author: GitAuthor,
  ): Promise<{ path: string; updatedAt: string }> {
    const folderNorm = folder ? this.validateFolderPath(folder) : '';
    const base = sanitizeTitle(title);
    const absFolder = folderNorm
      ? resolveInLibrary(this.libraryPath, folderNorm)
      : this.libraryPath;
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
    const finalContent = normalizedContent.endsWith('\n')
      ? normalizedContent
      : `${normalizedContent}\n`;
    const buf = Buffer.from(finalContent, 'utf8');
    // writeExclusive は既存でEEXIST。連番は付けずそのまま「衝突」として上位に伝える
    // (呼び出し側でレース時のフォールバック=既存の再取得ができるように InvalidPath でなく Conflict)
    const ok = await this.writeExclusive(abs, buf);
    if (!ok) {
      throw new DocConflictError(`既に存在します: ${normalized}`);
    }
    await this.tryCommit([normalized], `add: ${normalized}`, author);
    await this.tryUpdateIndex(
      () => this.indexer.indexFile(normalized),
      { path: normalized },
      '文書',
    );
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
    frontmatterOps?: FrontmatterOp[],
  ): Promise<SaveDocResponse> {
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
    const content = this.composeContent(current, body, tags, undefined, undefined, {
      ops: frontmatterOps,
    }).replace(/\r\n/g, '\n');
    await this.writeAtomic(abs, content);
    await this.tryCommit([normalized], `edit: ${normalized}`, author);
    await this.tryUpdateIndex(
      () => this.indexer.indexFile(normalized),
      { path: normalized },
      '文書',
    );
    // 明示保存に成功したら本人の下書きは不要になる(FR-EDIT-08)
    this.drafts.removeOwn(normalized, userId);
    const after = await stat(abs);
    return {
      updatedAt: after.mtime.toISOString(),
      frontmatter: this.parseFrontmatterData(content),
    };
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
    frontmatter?: Record<string, unknown>,
  ): Promise<{ updatedAt: string; frontmatter: Record<string, unknown> }> {
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

    // body 先頭に YAML ヘッダーがある場合、フロントマター二重化を防ぐため抽出・マージする(issue #286)
    const extracted = extractLeadingFrontmatter(body);
    const effectiveBody = extracted.body;
    const effectiveTags = tags !== undefined ? tags : extracted.tags;

    // 保存はLFに統一する(NFR-COMP-03。CRLF文書も保存時にLF化する)
    const content = this.composeContent(
      current,
      effectiveBody,
      effectiveTags,
      frontmatter,
      extracted.frontmatter,
    ).replace(/\r\n/g, '\n');
    await this.writeAtomic(abs, content);
    await this.tryCommit([normalized], `edit: ${normalized}`, author);
    await this.tryUpdateIndex(
      () => this.indexer.indexFile(normalized),
      { path: normalized },
      '文書',
    );
    const after = await stat(abs);
    return {
      updatedAt: after.mtime.toISOString(),
      frontmatter: this.parseFrontmatterData(content),
    };
  }

  // MCPの追記系ツール(#288)用の保存。同一パスへの呼び出しは直列化し、ロック検査から
  // 読み取り・書き込みまでを他の追記・フロントマター更新と交錯させない
  // (同時に呼ばれても互いの変更を上書きしないため)。
  // 本文は保存側(composeContent)と同じ FM_BLOCK_RE で切り出して transform に渡し、
  // 結果をそのまま本文として書き戻す(body 先頭の YAML 風ブロックは抽出しない)。
  // UI編集ロック中は saveDocMcp と同じく DocLockedError で拒否する
  async appendDocMcp(
    relPath: string,
    transform: (body: string) => string,
    author: GitAuthor,
    baseUpdatedAt?: string,
  ): Promise<{ path: string; updatedAt: string }> {
    const normalized = this.validateDocPath(relPath);
    const { updatedAt } = await this.serializedMcpEdit(
      normalized,
      author,
      baseUpdatedAt,
      (current) => ({
        body: transform(bodyAfterFrontmatter(current)),
      }),
    );
    return { path: normalized, updatedAt };
  }

  // MCP経由の期待文字列つき部分置換(#311)。本文の一部を置換・削除する。
  // 追記(appendDocMcp)やフロントマター更新と同じ直列化キューに載るため交錯しない。
  // 本文のみを対象とし、フロントマターはそのまま保持する。
  async patchDocMcp(
    relPath: string,
    edits: PatchEdit[],
    author: GitAuthor,
    baseUpdatedAt?: string,
  ): Promise<{ path: string; updatedAt: string }> {
    const docNorm = this.validateDocPath(relPath);
    const { updatedAt } = await this.serializedMcpEdit(
      docNorm,
      author,
      baseUpdatedAt,
      (current) => {
        const hasFm = FM_BLOCK_RE.test(current);
        const body = bodyAfterFrontmatter(current);
        const patched = guardFrontmatter(body, applyPatches(body, edits), hasFm);
        return { body: patched };
      },
    );
    return { path: docNorm, updatedAt };
  }

  // MCP経由のフロントマターのみの更新(#292)。本文は一切変えず、プロパティとタグだけを書き換える。
  // 追記(appendDocMcp)と同じ直列化キューに載るため、同じパスへの追記と交錯しない。
  // tags は全置き換え、addTags / removeTags は現在のフロントマター tags への差分適用
  // (インライン #タグは対象外)。baseUpdatedAt 指定時のみ mtime 比較で競合検知する
  async updateFrontmatterMcp(
    relPath: string,
    patch: {
      frontmatter?: Record<string, unknown>;
      tags?: string[];
      addTags?: string[];
      removeTags?: string[];
    },
    baseUpdatedAt: string | undefined,
    author: GitAuthor,
  ): Promise<{ updatedAt: string; frontmatter: Record<string, unknown>; tags: string[] }> {
    const normalized = this.validateDocPath(relPath);
    let tags: TagsUpdate | undefined = patch.tags;
    if (tags === undefined && (patch.addTags?.length || patch.removeTags?.length)) {
      // 今のタグは composeContent が書き戻しに使う yaml Document から読む(解釈差でタグを落とさない)
      const add = (patch.addTags ?? []).map(normalizeTagName).filter(Boolean);
      const remove = new Set((patch.removeTags ?? []).map(normalizeTagName));
      tags = (current) => {
        const next = [...current];
        for (const t of add) {
          if (!next.includes(t)) next.push(t);
        }
        return next.filter((t) => !remove.has(t));
      };
    }
    const { updatedAt, content } = await this.serializedMcpEdit(
      normalized,
      author,
      baseUpdatedAt,
      (current) => ({
        body: bodyAfterFrontmatter(current),
        tags,
        frontmatter: patch.frontmatter,
        // 壊れたフロントマターはタグだけの指定でもエラーにし、ファイルを書かない
        strictFrontmatter: true,
      }),
    );
    return {
      updatedAt,
      frontmatter: this.parseFrontmatterData(content),
      tags: parseDocMeta(content).frontmatterTags,
    };
  }

  // パスごとの直列化キューに載せて mcpEditLocked を実行する
  private async serializedMcpEdit(
    normalized: string,
    author: GitAuthor,
    baseUpdatedAt: string | undefined,
    plan: (current: string) => McpEditPlan,
  ): Promise<{ updatedAt: string; content: string }> {
    const prev = this.appendTails.get(normalized) ?? Promise.resolve();
    const run = prev.then(() => this.mcpEditLocked(normalized, author, baseUpdatedAt, plan));
    const tail = run.catch(() => undefined);
    this.appendTails.set(normalized, tail);
    try {
      return await run;
    } finally {
      if (this.appendTails.get(normalized) === tail) this.appendTails.delete(normalized);
    }
  }

  // ロック検査 → 読み取り → (任意)競合検知 → composeContent → 書き込み → コミット → 索引更新。
  // plan が現在の全文から、書き戻す本文・タグ・フロントマター更新を決める
  private async mcpEditLocked(
    normalized: string,
    author: GitAuthor,
    baseUpdatedAt: string | undefined,
    plan: (current: string) => McpEditPlan,
  ): Promise<{ updatedAt: string; content: string }> {
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
    // 競合検知は baseUpdatedAt が渡されたときだけ行う(saveDocMcp と同じ mtime 比較)
    if (baseUpdatedAt !== undefined && st.mtime.toISOString() !== baseUpdatedAt) {
      throw new DocConflictError(
        'この文書は取得後に変更されています。内容を退避してから再読み込みしてください',
      );
    }

    const plan_ = plan(current);
    const content =
      plan_.rawContent !== undefined
        ? plan_.rawContent
        : this.composeContent(current, plan_.body, plan_.tags, plan_.frontmatter, undefined, {
            strict: plan_.strictFrontmatter,
          }).replace(/\r\n/g, '\n');
    await this.writeAtomic(abs, content);
    await this.tryCommit([normalized], plan_.commitMessage ?? `edit: ${normalized}`, author);
    await this.tryUpdateIndex(
      () => this.indexer.indexFile(normalized),
      { path: normalized },
      '文書',
    );
    const after = await stat(abs);
    return { updatedAt: after.mtime.toISOString(), content };
  }

  // フロントマターの再結合(外科的編集)。yamlのDocument APIで tags / updated / frontmatter
  // ノードだけを差し替え、他キー・コメント・キー順・スタイルは原文のまま保持する
  // (FR-OBS-07。gray-matterでの再直列化はコメント脱落等の無関係な差分を生むため)
  private composeContent(
    current: string,
    body: string,
    tags: TagsUpdate | undefined,
    frontmatter?: Record<string, unknown>,
    bodyFrontmatter?: Record<string, unknown>,
    options: { strict?: boolean; ops?: FrontmatterOp[] } = {},
  ): string {
    const patch = validateFrontmatterPatch(frontmatter);
    const bodyPatch = validateFrontmatterPatch(bodyFrontmatter);
    const ops = options.ops ?? [];
    const hasOps = ops.length > 0;
    const tagsUpdater = typeof tags === 'function' ? tags : undefined;
    const normalizedTags = Array.isArray(tags)
      ? tags.map(normalizeTagName).filter(Boolean)
      : undefined;
    // strict(update_frontmatter)では、タグの指定だけでも壊れたフロントマターを拒否する
    // #282: ops がある場合も壊れたフロントマターを拒否する
    const rejectBroken =
      (patch !== undefined && Object.keys(patch).length > 0) ||
      (bodyPatch !== undefined && Object.keys(bodyPatch).length > 0) ||
      (options.strict === true && tags !== undefined) ||
      hasOps;

    const fmMatch = FM_BLOCK_RE.exec(current);
    if (!fmMatch) {
      // 元々フロントマターがない文書
      if ((options.strict || hasOps) && /^---\r?\n/.test(body)) {
        // 未終端フロントマター等、解釈の割れる文書には何も書かない(タグだけの指定でも拒否)
        throw new FrontmatterUpdateError(
          'フロントマターの解析に失敗しました(未終端または不正な形式)',
        );
      }
      // body 先頭ヘッダー由来のプロパティは空値(null)も含めて保持する
      const fmObj: Record<string, unknown> = {};
      if (bodyPatch) {
        for (const [k, v] of Object.entries(bodyPatch)) {
          fmObj[k] = v;
        }
      }
      // 明示的な frontmatter 引数は null でキー削除、それ以外で上書き
      if (patch) {
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) {
            delete fmObj[k];
          } else {
            fmObj[k] = v;
          }
        }
      }
      // #282: ops を適用 (set は null も値として残す)
      if (hasOps) {
        for (const op of ops) {
          if (op.op === 'set') {
            fmObj[normalizeOpKey(op.key)] = op.value;
          }
          // delete / rename は FM なし文書では対象がないため何もしない
        }
      }

      const newTags = normalizedTags ?? tagsUpdater?.([]).map(normalizeTagName).filter(Boolean);
      const hasTags = newTags !== undefined && newTags.length > 0;
      const hasProps = Object.keys(fmObj).length > 0;

      if (!hasTags && !hasProps) {
        return body;
      }

      if (/^---\r?\n/.test(body)) {
        // 未終端フロントマター等、解釈の割れる文書にはFMを追加しない(二重化防止)
        if (rejectBroken) {
          throw new FrontmatterUpdateError(
            'フロントマターの解析に失敗しました(未終端または不正な形式)',
          );
        }
        this.logger?.warn('フロントマターの構造が不明なためタグ更新をスキップしました');
        return body;
      }

      if (hasTags) {
        fmObj.tags = newTags;
      }
      fmObj.updated = localIso();
      const fm = yamlStringify(fmObj);
      return `---\n${fm}---\n\n${body.replace(/^\n/, '')}`;
    }

    const doc = parseYamlDocument(fmMatch[1]);
    const hasSyntaxError =
      doc.errors.length > 0 ||
      (hasOps &&
        isMap(doc.contents) &&
        doc.contents.items.some(
          (p) =>
            !isScalar(p.key) ||
            p.key.value === null ||
            !String(p.key.value).normalize('NFC').trim(),
        ));
    if (hasSyntaxError) {
      // 壊れたフロントマター
      if (rejectBroken) {
        throw new FrontmatterUpdateError('フロントマターの解析に失敗しました(構文エラー)');
      }
      this.logger?.warn(
        { errors: doc.errors.map((e) => e.message) },
        '壊れたフロントマターのためタグ更新をスキップしました',
      );
      return body.startsWith('---')
        ? body
        : current.slice(0, fmMatch[0].length) + body.replace(/^\n/, '');
    }

    const json = doc.toJSON();
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      if (
        (patch !== undefined && Object.keys(patch).length > 0) ||
        (bodyPatch !== undefined && Object.keys(bodyPatch).length > 0) ||
        hasOps ||
        // strict でも、中身が空のフロントマター(json が null)にはタグを足せるようにする
        (options.strict === true && tags !== undefined && json !== null && json !== undefined)
      ) {
        throw new FrontmatterUpdateError(
          'フロントマターのルートがマップ(オブジェクト)ではありません',
        );
      }
    }

    // 1. body 先頭ヘッダー由来のプロパティを適用
    // 値が null のキー(aliases: など)は削除命令ではなく空プロパティのため、
    // 既存値があれば維持し、なければ空値(doc.set(key, null))として保持する
    if (bodyPatch) {
      for (const [key, value] of Object.entries(bodyPatch)) {
        if (value === null) {
          if (!doc.has(key)) {
            doc.set(key, null);
          }
        } else {
          doc.set(key, value);
        }
      }
    }

    // 2. 明示的な frontmatter 引数を適用(引数が優先)
    // 値が null の場合はキーを削除(doc.delete)、それ以外は上書き
    if (patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
          doc.delete(key);
        } else {
          doc.set(key, value);
        }
      }
    }

    // 3. #282: ops を適用
    if (hasOps) {
      applyFrontmatterOps(doc, ops);
    }

    if (normalizedTags !== undefined) {
      if (normalizedTags.length > 0) doc.set('tags', normalizedTags);
      else doc.delete('tags');
    } else if (tagsUpdater) {
      applyTagsUpdateToDocument(doc, tagsUpdater);
    }
    doc.set('updated', localIso());
    return `---\n${doc.toString()}---\n${body}`;
  }

  async deleteDoc(relPath: string, userId: number, author: GitAuthor): Promise<DeleteDocResponse> {
    const normalized = this.validateDocPath(relPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    if (!(await this.exists(abs))) {
      throw new DocNotFoundError(normalized);
    }
    // 他ユーザーが編集中の文書は削除できない(編集中削除の事故防止)
    this.locks.assertNotLockedByOther(normalized, userId);
    const trashDir = path.join(this.libraryPath, '.trash');
    await mkdir(trashDir, { recursive: true });

    const attSettings = this.librarySettings
      ? (await this.librarySettings.get()).settings.attachments
      : attachmentSettingsFromEnv(this.config.attachmentDirMode);

    // #161: same-folder / doc-subfolder の場合は他文書と非共有の専属添付を同伴対象にする(best-effort)
    const skippedAttachments: SkippedAttachment[] = [];
    const seenSkipped = new Set<string>();
    const addSkipped = (fileName: string, reason: SkippedAttachment['reason']) => {
      const key = `${reason}:${fileName}`;
      if (seenSkipped.has(key)) return;
      seenSkipped.add(key);
      skippedAttachments.push({ fileName, reason });
    };

    const docFolder = folderOfDoc(normalized);
    let docSubfolderDir: string | null = null;
    let exclusiveAttRels: string[] = [];
    if (attSettings.mode !== 'vault-folder') {
      try {
        const content = await readFile(abs, 'utf8');
        const sourceDir =
          attSettings.mode === 'same-folder'
            ? docFolder
            : docFolder
              ? `${docFolder}/${attSettings.folder}`
              : attSettings.folder;
        if (attSettings.mode === 'doc-subfolder') {
          docSubfolderDir = sourceDir;
        }
        const preIndexRows = this.db.prepare('SELECT rel_path FROM attachment_index').all() as {
          rel_path: string;
        }[];
        const preIndexedPaths = preIndexRows.map((r) => r.rel_path);
        const preIndexedSet = new Set(preIndexedPaths);
        const preByName = buildByNameIndex(preIndexedPaths);
        const resolvePreIndexedWikilink = (target: string, fromDoc: string): string | null =>
          resolveAttachmentFromByName(target, fromDoc, (b) => preByName.get(b) ?? []);

        const { body } = splitFrontmatter(content);
        const candidateRels = await this.extractMovableAttachmentsForDoc(
          body,
          normalized,
          docFolder,
          sourceDir,
          attSettings,
          preIndexedSet,
          resolvePreIndexedWikilink,
        );
        if (candidateRels.length > 0) {
          const shared = await this.findSharedAttachments(
            candidateRels,
            new Set([normalized]),
            attSettings,
            preIndexedSet,
            resolvePreIndexedWikilink,
          );
          for (const attRel of candidateRels) {
            if (shared.has(attRel)) {
              addSkipped(path.posix.basename(attRel), 'shared');
            } else {
              exclusiveAttRels.push(attRel);
            }
          }
        }
      } catch (e) {
        this.logger?.warn(
          { err: e, docPath: normalized },
          '削除時の添付同伴走査に失敗しました(文書のみごみ箱へ移動します)',
        );
        exclusiveAttRels = [];
      }
    }

    // ごみ箱内の同名衝突は連番で回避
    const reservedTrashNames = new Set<string>([TRASH_META_FILE.toLowerCase()]);
    const allocateTrashName = async (fileName: string): Promise<string> => {
      const ext = path.posix.extname(fileName);
      const stem = ext ? fileName.slice(0, fileName.length - ext.length) : fileName;
      let candidate = fileName;
      for (
        let i = 2;
        reservedTrashNames.has(candidate.toLowerCase()) ||
        (await this.exists(path.join(trashDir, candidate)));
        i++
      ) {
        candidate = `${stem} (${i})${ext}`;
      }
      reservedTrashNames.add(candidate.toLowerCase());
      return candidate;
    };

    const trashName = await allocateTrashName(path.posix.basename(normalized));
    const docTrashAbs = path.join(trashDir, trashName);
    const attMoves: {
      originalPath: string;
      oldAbs: string;
      trashName: string;
      trashPath: string;
      trashAbs: string;
    }[] = [];
    for (const attRel of exclusiveAttRels) {
      const attTrashName = await allocateTrashName(path.posix.basename(attRel));
      attMoves.push({
        originalPath: attRel,
        oldAbs: resolveInLibrary(this.libraryPath, attRel),
        trashName: attTrashName,
        trashPath: `.trash/${attTrashName}`,
        trashAbs: path.join(trashDir, attTrashName),
      });
    }

    const movedItems: { oldAbs: string; trashAbs: string }[] = [];
    try {
      await this.moveFile(abs, docTrashAbs);
      movedItems.push({ oldAbs: abs, trashAbs: docTrashAbs });
      for (const a of attMoves) {
        await this.moveFile(a.oldAbs, a.trashAbs);
        movedItems.push({ oldAbs: a.oldAbs, trashAbs: a.trashAbs });
      }
    } catch (e) {
      for (const m of [...movedItems].reverse()) {
        try {
          await this.moveFile(m.trashAbs, m.oldAbs);
        } catch (rbErr) {
          this.logger?.error(
            { err: rbErr, from: m.trashAbs, to: m.oldAbs },
            'ごみ箱移動のロールバックに失敗しました',
          );
        }
      }
      throw e;
    }

    // 同伴添付がある場合は由来マニフェストを記録(既存マニフェストに同名残骸があれば掃除)
    // 書き込み失敗時は移動済みファイルをすべてロールバックして不整合を防ぐ
    const manifestAbs = path.join(trashDir, TRASH_META_FILE);
    if (attMoves.length > 0 || (await this.exists(manifestAbs))) {
      try {
        await this.updateTrashFileManifest((manifest) => {
          if (attMoves.length > 0) {
            manifest.items[trashName] = {
              originalPath: normalized,
              deletedAt: new Date().toISOString(),
              deletedBy: author.name,
              attachments: attMoves.map((a) => ({
                trashPath: a.trashPath,
                originalPath: a.originalPath,
              })),
            };
          } else {
            delete manifest.items[trashName];
          }
        });
      } catch (e) {
        for (const m of [...movedItems].reverse()) {
          try {
            await this.moveFile(m.trashAbs, m.oldAbs);
          } catch (rbErr) {
            this.logger?.error(
              { err: rbErr, from: m.trashAbs, to: m.oldAbs },
              'ごみ箱移動のロールバックに失敗しました',
            );
          }
        }
        throw e;
      }
    }

    // doc-subfolder で添付をすべて移動してサブフォルダが空になった場合は掃除する(文書フォルダ自体は残す)
    if (attMoves.length > 0 && docSubfolderDir && attSettings.mode === 'doc-subfolder') {
      await this.removeEmptySubdirsUpTo(docSubfolderDir, docFolder);
    }

    // スコープコミット: 無関係な外部変更を巻き込まない(それらはsyncが拾う)
    // 同伴添付がある場合はGitコミット本文にもトレーラーを残し、マニフェスト不在・破損時も元パスを特定できるようにする
    const commitPaths = [
      normalized,
      `.trash/${trashName}`,
      ...attMoves.flatMap((a) => [a.originalPath, a.trashPath]),
    ];
    const commitMessage =
      attMoves.length > 0
        ? `trash: ${normalized}\n\n${attMoves
            .map(
              (a) =>
                `${TRASH_ATTACHMENT_TRAILER_PREFIX}${JSON.stringify({
                  trashPath: a.trashPath,
                  originalPath: a.originalPath,
                })}`,
            )
            .join('\n')}`
        : `trash: ${normalized}`;
    await this.tryCommit(commitPaths, commitMessage, author);
    await this.tryUpdateIndex(
      async () => this.indexer.removeFile(normalized),
      { path: normalized },
      '文書',
    );
    for (const a of attMoves) {
      await this.tryUpdateIndex(
        async () => this.indexer.removeAttachment(a.originalPath),
        { relPath: a.originalPath },
        '添付',
      );
    }
    this.locks.forceRelease(normalized);
    this.drafts.removeAll(normalized);
    return { ok: true, skippedAttachments };
  }

  async moveDoc(
    relPath: string,
    newFolder: string,
    newTitle: string,
    userId: number,
    author: GitAuthor,
  ): Promise<MovedDocResponse> {
    const result = await this.moveDocsBatch(
      [{ path: relPath, newFolder, newTitle }],
      userId,
      author,
    );
    return {
      path: result.moved[0].path,
      skippedAttachments: result.skippedAttachments,
    };
  }

  // 複数文書の一括移動(#334)。グループ内で専属判定・doc-subfolder追従・リンク書き換え・
  // 全ロールバック・単一Gitコミットを行い、共有・同名衝突で残置した添付を返す。
  async moveDocsBatch(
    moves: MoveDocRequest[],
    userId: number,
    author: GitAuthor,
  ): Promise<MoveDocsBatchResponse> {
    if (moves.length === 0) {
      return { moved: [], skippedAttachments: [] };
    }

    interface ValidatedMove {
      oldNorm: string;
      oldAbs: string;
      newNorm: string;
      newAbs: string;
      oldFolder: string;
      newFolder: string;
      folderChanged: boolean;
      noop: boolean;
    }

    const validated: ValidatedMove[] = [];
    const seenOldLower = new Set<string>();
    for (const item of moves) {
      const oldNorm = this.validateDocPath(item.path);
      const oldLower = oldNorm.toLowerCase();
      if (seenOldLower.has(oldLower)) {
        throw new InvalidPathError(item.path, `同一の移動元文書が重複しています: ${oldNorm}`);
      }
      seenOldLower.add(oldLower);

      const oldAbs = resolveInLibrary(this.libraryPath, oldNorm);
      if (!(await this.exists(oldAbs))) {
        throw new DocNotFoundError(oldNorm);
      }
      this.locks.assertNotLockedByOther(oldNorm, userId);

      const folderNorm = item.newFolder ? this.validateFolderPath(item.newFolder) : '';
      const fileName = `${sanitizeTitle(item.newTitle)}.md`;
      const newNorm = folderNorm ? `${folderNorm}/${fileName}` : fileName;
      const newAbs = resolveInLibrary(this.libraryPath, newNorm);
      const oldFolder = folderOfDoc(oldNorm);
      const folderChanged =
        folderNorm !== oldFolder && folderNorm.toLowerCase() !== oldFolder.toLowerCase();

      validated.push({
        oldNorm,
        oldAbs,
        newNorm,
        newAbs,
        oldFolder,
        newFolder: folderNorm,
        folderChanged,
        noop: newNorm === oldNorm,
      });
    }

    const activeMoves = validated.filter((m) => !m.noop);
    if (activeMoves.length === 0) {
      return {
        moved: validated.map((m) => ({ oldPath: m.oldNorm, path: m.newNorm })),
        skippedAttachments: [],
      };
    }

    const activeOldLower = new Set(activeMoves.map((m) => m.oldNorm.toLowerCase()));
    const seenDestLower = new Set<string>();
    for (const m of activeMoves) {
      const destLower = m.newNorm.toLowerCase();
      if (seenDestLower.has(destLower)) {
        throw new DocConflictError(`移動先の文書パスが重複しています: ${m.newNorm}`);
      }
      seenDestLower.add(destLower);

      const caseOnly = destLower === m.oldNorm.toLowerCase();
      const vacatedByBatch = activeOldLower.has(destLower);
      if (!caseOnly && !vacatedByBatch && (await this.exists(m.newAbs))) {
        throw new DocConflictError(`移動先に同名の文書があります: ${m.newNorm}`);
      }
    }

    const attSettings = this.librarySettings
      ? (await this.librarySettings.get()).settings.attachments
      : attachmentSettingsFromEnv(this.config.attachmentDirMode);

    // 各移動文書の本文を読み込み、同伴候補添付を収集する(best-effort)
    const docContentMap = new Map<string, string>();
    const preIndexRows = this.db.prepare('SELECT rel_path FROM attachment_index').all() as {
      rel_path: string;
    }[];
    const preIndexedPaths = preIndexRows.map((r) => r.rel_path);
    const preIndexedSet = new Set(preIndexedPaths);
    const preByName = buildByNameIndex(preIndexedPaths);
    const resolvePreIndexedWikilink = (target: string, fromDoc: string): string | null =>
      resolveAttachmentFromByName(target, fromDoc, (b) => preByName.get(b) ?? []);

    interface AttMoveCandidate {
      oldRel: string;
      newRel: string | null; // null = バッチ内で移動先が不一致(共有扱い)
      fileName: string;
    }
    const candidateByAttRel = new Map<string, AttMoveCandidate>();
    const perDocCandidateRels = new Map<string, Set<string>>();

    for (const m of activeMoves) {
      try {
        const content = await readFile(m.oldAbs, 'utf8');
        docContentMap.set(m.oldNorm, content);
        if (!m.folderChanged || attSettings.mode === 'vault-folder') continue;

        const sourceDir =
          attSettings.mode === 'same-folder'
            ? m.oldFolder
            : m.oldFolder
              ? `${m.oldFolder}/${attSettings.folder}`
              : attSettings.folder;
        const destDir =
          attSettings.mode === 'same-folder'
            ? m.newFolder
            : m.newFolder
              ? `${m.newFolder}/${attSettings.folder}`
              : attSettings.folder;

        const { body } = splitFrontmatter(content);
        const foundRels = await this.extractMovableAttachmentsForDoc(
          body,
          m.oldNorm,
          m.oldFolder,
          sourceDir,
          attSettings,
          preIndexedSet,
          resolvePreIndexedWikilink,
        );
        perDocCandidateRels.set(m.oldNorm, new Set(foundRels));
        for (const attOldRel of foundRels) {
          const base = path.posix.basename(attOldRel);
          const attNewRel = destDir ? `${destDir}/${base}` : base;
          const existing = candidateByAttRel.get(attOldRel);
          if (!existing) {
            candidateByAttRel.set(attOldRel, {
              oldRel: attOldRel,
              newRel: attNewRel,
              fileName: base,
            });
          } else if (existing.newRel !== null && existing.newRel !== attNewRel) {
            existing.newRel = null;
          }
        }
      } catch (e) {
        // 添付走査は best-effort。失敗しても文書自体の移動は継続する
        this.logger?.warn({ err: e, docPath: m.oldNorm }, '添付の同伴走査に失敗しました');
      }
    }

    // 移動グループ外の文書による共有チェック
    const excludeDocPaths = new Set(activeMoves.map((m) => m.oldNorm));
    const skippedAttachments: SkippedAttachment[] = [];
    const seenSkipped = new Set<string>();
    const addSkipped = (fileName: string, reason: SkippedAttachment['reason']) => {
      const key = `${reason}:${fileName}`;
      if (seenSkipped.has(key)) return;
      seenSkipped.add(key);
      skippedAttachments.push({ fileName, reason });
    };

    const allCandidateRels = [...candidateByAttRel.keys()];
    const splitDestShared = new Set<string>();
    for (const [attRel, cand] of candidateByAttRel) {
      if (cand.newRel === null) {
        splitDestShared.add(attRel);
        addSkipped(cand.fileName, 'shared');
      }
    }

    const externallyShared = await this.findSharedAttachments(
      allCandidateRels.filter((r) => !splitDestShared.has(r)),
      excludeDocPaths,
      attSettings,
      preIndexedSet,
      resolvePreIndexedWikilink,
    );
    for (const attRel of externallyShared) {
      const cand = candidateByAttRel.get(attRel);
      if (cand) addSkipped(cand.fileName, 'shared');
    }

    // 同名衝突判定(ディスク上の既存ファイルおよび同一バッチ内の別ソースからの合流衝突)
    // conflict で残置された添付の移動元は空かないため、残置がなくなるまで反復収束させる(M1)
    let activeAttCands = [...candidateByAttRel.entries()]
      .filter(
        ([attRel, cand]) =>
          !splitDestShared.has(attRel) && !externallyShared.has(attRel) && cand.newRel !== null,
      )
      .map(([attRel, cand]) => ({
        oldRel: attRel,
        newRel: cand.newRel!,
        fileName: cand.fileName,
      }));

    let resolvedAttCands: typeof activeAttCands = [];
    while (activeAttCands.length > 0) {
      const vacatedAttLower = new Set(activeAttCands.map((c) => c.oldRel.toLowerCase()));
      const claimedAttDestLower = new Set<string>();
      const nextActive: typeof activeAttCands = [];
      let droppedAny = false;

      for (const cand of activeAttCands) {
        const destLower = cand.newRel.toLowerCase();
        const attNewAbs = resolveInLibrary(this.libraryPath, cand.newRel);
        const occupiedByOtherInBatch = claimedAttDestLower.has(destLower);
        const occupiedOnDisk =
          destLower !== cand.oldRel.toLowerCase() &&
          !vacatedAttLower.has(destLower) &&
          (await this.exists(attNewAbs));
        if (occupiedByOtherInBatch || occupiedOnDisk) {
          addSkipped(cand.fileName, 'conflict');
          droppedAny = true;
          continue;
        }
        claimedAttDestLower.add(destLower);
        nextActive.push(cand);
      }

      activeAttCands = nextActive;
      if (!droppedAny) {
        resolvedAttCands = nextActive;
        break;
      }
    }

    const attachmentMoves: {
      oldRel: string;
      newRel: string;
      oldAbs: string;
      tmpAbs: string;
      newAbs: string;
    }[] = [];
    const movedAttMap = new Map<string, string>();
    for (const cand of resolvedAttCands) {
      const attOldAbs = resolveInLibrary(this.libraryPath, cand.oldRel);
      const attNewAbs = resolveInLibrary(this.libraryPath, cand.newRel);
      const tmpAbs = path.join(
        path.dirname(attOldAbs),
        `.tsumiwiki-tmp-move-${randomBytes(6).toString('hex')}`,
      );
      attachmentMoves.push({
        oldRel: cand.oldRel,
        newRel: cand.newRel,
        oldAbs: attOldAbs,
        tmpAbs,
        newAbs: attNewAbs,
      });
      movedAttMap.set(cand.oldRel, cand.newRel);
    }

    // 移動後の添付インデックスを構築し、本文リンク書き換えが必要なら事前計算する
    const postPathSet = new Set<string>();
    for (const p of preIndexedPaths) {
      postPathSet.add(movedAttMap.get(p) ?? p);
    }
    for (const r of allCandidateRels) {
      postPathSet.add(movedAttMap.get(r) ?? r);
    }
    const postByName = buildByNameIndex([...postPathSet]);
    const resolvePostWikilink = (target: string, fromDoc: string): string | null =>
      resolveAttachmentFromByName(target, fromDoc, (b) => postByName.get(b) ?? []);
    const allKnownAttLower = new Map<string, string>();
    for (const p of preIndexedPaths) allKnownAttLower.set(p.toLowerCase(), p);
    for (const r of allCandidateRels) allKnownAttLower.set(r.toLowerCase(), r);

    const docMoveStates = activeMoves.map((m) => {
      const oldContent = docContentMap.get(m.oldNorm);
      let nextContent: string | null = null;
      if (oldContent !== undefined && (m.folderChanged || movedAttMap.size > 0)) {
        const candidateRels = perDocCandidateRels.get(m.oldNorm);
        const updated = this.rewriteMovedDocContent(
          oldContent,
          m.oldNorm,
          m.newNorm,
          m.oldFolder,
          m.newFolder,
          attSettings,
          movedAttMap,
          allKnownAttLower,
          candidateRels,
          resolvePreIndexedWikilink,
          resolvePostWikilink,
        );
        if (updated !== oldContent) {
          nextContent = updated;
        }
      }
      const tmpAbs = path.join(
        path.dirname(m.oldAbs),
        `.tsumiwiki-tmp-move-${randomBytes(6).toString('hex')}`,
      );
      return {
        ...m,
        tmpAbs,
        oldContent,
        nextContent,
        stage: 'at-old' as 'at-old' | 'at-tmp' | 'at-new',
        rewritten: false,
      };
    });

    const attStates = attachmentMoves.map((a) => ({
      ...a,
      stage: 'at-old' as 'at-old' | 'at-tmp' | 'at-new',
    }));

    // 2フェーズ移動(文書・添付とも一時名経由で衝突・スワップ・大文字小文字変更を安全に処理)
    try {
      for (const d of docMoveStates) {
        await this.moveFile(d.oldAbs, d.tmpAbs);
        d.stage = 'at-tmp';
      }
      for (const a of attStates) {
        await this.moveFile(a.oldAbs, a.tmpAbs);
        a.stage = 'at-tmp';
      }
      for (const d of docMoveStates) {
        await mkdir(path.dirname(d.newAbs), { recursive: true });
        await this.moveFile(d.tmpAbs, d.newAbs);
        d.stage = 'at-new';
        if (d.nextContent !== null) {
          await this.writeAtomic(d.newAbs, d.nextContent);
          d.rewritten = true;
        }
      }
      for (const a of attStates) {
        await mkdir(path.dirname(a.newAbs), { recursive: true });
        await this.moveFile(a.tmpAbs, a.newAbs);
        a.stage = 'at-new';
      }
    } catch (e) {
      this.logger?.error(
        { err: e, count: activeMoves.length },
        '文書・添付の移動に失敗したため、変更をすべてロールバックします',
      );
      for (const a of [...attStates].reverse()) {
        if (a.stage === 'at-new') {
          try {
            await this.moveFile(a.newAbs, a.tmpAbs);
            a.stage = 'at-tmp';
          } catch (rbErr) {
            this.logger?.error(
              { err: rbErr, from: a.newAbs, to: a.tmpAbs },
              '添付ロールバック失敗',
            );
          }
        }
      }
      for (const d of [...docMoveStates].reverse()) {
        if (d.stage === 'at-new') {
          try {
            if (d.rewritten && d.oldContent !== undefined) {
              await this.writeAtomic(d.newAbs, d.oldContent);
            }
            await this.moveFile(d.newAbs, d.tmpAbs);
            d.stage = 'at-tmp';
          } catch (rbErr) {
            this.logger?.error(
              { err: rbErr, from: d.newAbs, to: d.tmpAbs },
              '文書ロールバック失敗',
            );
          }
        }
      }
      for (const a of [...attStates].reverse()) {
        if (a.stage === 'at-tmp') {
          try {
            await this.moveFile(a.tmpAbs, a.oldAbs);
            a.stage = 'at-old';
          } catch (rbErr) {
            this.logger?.error({ err: rbErr, from: a.tmpAbs, to: a.oldAbs }, '添付復元失敗');
          }
        }
      }
      for (const d of [...docMoveStates].reverse()) {
        if (d.stage === 'at-tmp') {
          try {
            await this.moveFile(d.tmpAbs, d.oldAbs);
            d.stage = 'at-old';
          } catch (rbErr) {
            this.logger?.error({ err: rbErr, from: d.tmpAbs, to: d.oldAbs }, '文書復元失敗');
          }
        }
      }
      throw new Error(
        `移動処理に失敗したためロールバックしました: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const commitPathSet = new Set<string>();
    for (const d of docMoveStates) {
      commitPathSet.add(d.oldNorm);
      commitPathSet.add(d.newNorm);
    }
    for (const a of attStates) {
      commitPathSet.add(a.oldRel);
      commitPathSet.add(a.newRel);
    }
    const commitMsg =
      docMoveStates.length === 1
        ? `move: ${docMoveStates[0].oldNorm} -> ${docMoveStates[0].newNorm}`
        : `move batch: ${docMoveStates.length} docs`;
    await this.tryCommit([...commitPathSet], commitMsg, author);

    // インデックス・ロック・下書きは連鎖移動や入れ替え(vacatedByBatch)で中間上書きが起きないよう
    // 全件削除/一時キー退避 → 全件登録/新パス確定の 2 段階で追従させる(M2)
    for (const d of docMoveStates) {
      await this.tryUpdateIndex(
        async () => {
          this.indexer.removeFile(d.oldNorm);
          this.indexer.removeFile(d.newNorm);
        },
        { oldPath: d.oldNorm, newPath: d.newNorm },
        '文書削除',
      );
    }
    for (const d of docMoveStates) {
      await this.tryUpdateIndex(
        () => this.indexer.indexFile(d.newNorm),
        { path: d.newNorm },
        '文書登録',
      );
    }
    const repathToken = randomBytes(6).toString('hex');
    docMoveStates.forEach((d, idx) => {
      const tmpKey = `__batch_repath_${repathToken}/${idx}`;
      this.locks.repath(d.oldNorm, tmpKey);
      this.drafts.repath(d.oldNorm, tmpKey);
    });
    docMoveStates.forEach((d, idx) => {
      const tmpKey = `__batch_repath_${repathToken}/${idx}`;
      this.locks.repath(tmpKey, d.newNorm);
      this.drafts.repath(tmpKey, d.newNorm);
    });

    for (const a of attStates) {
      await this.tryUpdateIndex(
        async () => {
          this.indexer.removeAttachment(a.oldRel);
          this.indexer.removeAttachment(a.newRel);
        },
        { oldRel: a.oldRel, newRel: a.newRel },
        '添付削除',
      );
    }
    for (const a of attStates) {
      await this.tryUpdateIndex(
        () => this.indexer.indexAttachment(a.newRel),
        { relPath: a.newRel },
        '添付登録',
      );
    }

    return {
      moved: validated.map((m) => ({ oldPath: m.oldNorm, path: m.newNorm })),
      skippedAttachments,
    };
  }

  // 文書本文から移動対象ディレクトリ(same-folder / doc-subfolder)配下の参照済み添付実パスを抽出する(#334)
  private async extractMovableAttachmentsForDoc(
    body: string,
    docNorm: string,
    oldFolder: string,
    sourceDir: string,
    attSettings: LibrarySettings['attachments'],
    indexedSet: ReadonlySet<string>,
    resolveIndexedWikilink: (target: string, fromDoc: string) => string | null,
  ): Promise<string[]> {
    const ranges = computeCodeRanges(body);
    const candidates = new Set<string>();
    const subfolderLower = attSettings.folder.toLowerCase();
    const sourceDirLower = sourceDir.toLowerCase();

    for (const m of body.matchAll(WIKILINK_REWRITE_RE)) {
      const offset = (m.index ?? 0) + m[1].length;
      if (isWithinCode(ranges, offset)) continue;
      const { pathPart } = splitTargetSuffix(m[2]);
      if (!pathPart || EXCLUDED_SCHEME_RE.test(pathPart)) continue;
      const norm = normalizeEmbedTarget(pathPart);
      if (!norm) continue;
      const ext = path.posix.extname(norm).toLowerCase();
      if (!DocService.ATTACHMENT_EXTENSIONS.has(ext)) continue;

      let candRel: string | null = null;
      if (!norm.includes('/')) {
        candRel = sourceDir ? `${sourceDir}/${norm}` : norm;
      } else if (
        attSettings.mode === 'doc-subfolder' &&
        norm.toLowerCase().startsWith(`${subfolderLower}/`)
      ) {
        const rest = norm.slice(attSettings.folder.length + 1);
        if (!rest.includes('/')) {
          candRel = sourceDir ? `${sourceDir}/${rest}` : rest;
        }
      } else if (sourceDir && norm.toLowerCase().startsWith(`${sourceDirLower}/`)) {
        const rest = norm.slice(sourceDir.length + 1);
        if (!rest.includes('/')) {
          candRel = `${sourceDir}/${rest}`;
        }
      }

      if (!candRel) continue;
      const resolvedIndexed = resolveIndexedWikilink(norm, docNorm);
      if (
        resolvedIndexed &&
        resolvedIndexed.toLowerCase() !== candRel.toLowerCase() &&
        indexedSet.has(candRel)
      ) {
        continue;
      }
      try {
        if (await this.exists(resolveInLibrary(this.libraryPath, candRel))) {
          candidates.add(candRel);
        }
      } catch (e) {
        this.logger?.warn(
          { err: e, docPath: docNorm, target: pathPart },
          '不正な添付リンクをスキップしました',
        );
      }
    }

    for (const m of body.matchAll(MD_LINK_REWRITE_RE)) {
      const offset = (m.index ?? 0) + m[1].length;
      if (isWithinCode(ranges, offset)) continue;
      const { pathPart } = splitTargetSuffix(m[2]);
      if (!pathPart || EXCLUDED_SCHEME_RE.test(pathPart)) continue;
      const ext = path.posix.extname(pathPart).toLowerCase();
      if (!DocService.ATTACHMENT_EXTENSIONS.has(ext)) continue;

      try {
        const resolvedMd = resolveMarkdownRelPath(oldFolder, pathPart);
        if (resolvedMd) {
          const dirRaw = path.posix.dirname(resolvedMd);
          const dir = dirRaw === '.' ? '' : dirRaw;
          if (dir.toLowerCase() === sourceDirLower) {
            const base = path.posix.basename(resolvedMd);
            const candRel = sourceDir ? `${sourceDir}/${base}` : base;
            if (await this.exists(resolveInLibrary(this.libraryPath, candRel))) {
              candidates.add(candRel);
            }
            continue;
          }
        }

        // doc-subfolder で Markdown 画像記法に bare ファイル名のみ書いていた場合のフォールバック
        if (
          attSettings.mode === 'doc-subfolder' &&
          m[1].startsWith('!') &&
          ext !== '.pdf' &&
          !pathPart.includes('/')
        ) {
          const candRel = sourceDir ? `${sourceDir}/${pathPart.trim()}` : pathPart.trim();
          if (await this.exists(resolveInLibrary(this.libraryPath, candRel))) {
            candidates.add(candRel);
          }
        }
      } catch (e) {
        this.logger?.warn(
          { err: e, docPath: docNorm, target: pathPart },
          '不正な添付リンクをスキップしました',
        );
      }
    }

    return [...candidates];
  }

  // 移動対象グループ外の文書に共有参照されていないか判定し、共有されている添付 relPath の集合を返す(#159 / #334)
  private async findSharedAttachments(
    candidateRels: string[],
    excludeDocPaths: ReadonlySet<string>,
    attSettings: LibrarySettings['attachments'],
    indexedSet: ReadonlySet<string>,
    resolveIndexedWikilink: (target: string, fromDoc: string) => string | null,
  ): Promise<Set<string>> {
    const shared = new Set<string>();
    if (candidateRels.length === 0) return shared;

    const allDocs = (
      this.db.prepare('SELECT doc_path FROM doc_index').all() as { doc_path: string }[]
    )
      .map((r) => r.doc_path)
      .filter((p) => !excludeDocPaths.has(p));

    for (const otherDocPath of allDocs) {
      if (shared.size === candidateRels.length) break;
      let content: string;
      try {
        content = await readFile(resolveInLibrary(this.libraryPath, otherDocPath), 'utf8');
      } catch {
        continue;
      }
      const remaining = candidateRels.filter(
        (r) => !shared.has(r) && referencesFilename(content, path.posix.basename(r)),
      );
      if (remaining.length === 0) continue;

      const { body } = splitFrontmatter(content);
      const targets = extractLinkTargets(body);
      const otherFolder = folderOfDoc(otherDocPath);
      const otherLocalSubfolder =
        attSettings.mode === 'doc-subfolder'
          ? otherFolder
            ? `${otherFolder}/${attSettings.folder}`
            : attSettings.folder
          : otherFolder;

      for (const attRel of remaining) {
        const fileName = path.posix.basename(attRel);
        const fileLower = fileName.toLowerCase();
        const attLower = attRel.toLowerCase();

        // リンク構文内に該当ファイル名が出現している場合、別フォルダの固有添付へ解決されるなら共有扱いしない
        const matchingTargets = targets.filter(
          (t) => path.posix.basename(t.replaceAll('\\', '/')).toLowerCase() === fileLower,
        );
        if (matchingTargets.length === 0) {
          shared.add(attRel);
          continue;
        }

        let pointsToCandidate = false;
        for (const t of matchingTargets) {
          const norm = normalizeEmbedTarget(t);
          if (!norm) {
            pointsToCandidate = true;
            break;
          }
          if (!norm.includes('/')) {
            const indexedResolved = resolveIndexedWikilink(norm, otherDocPath);
            if (indexedResolved && indexedResolved.toLowerCase() === attLower) {
              pointsToCandidate = true;
              break;
            }
            const ownLocalRel = otherLocalSubfolder ? `${otherLocalSubfolder}/${norm}` : norm;
            const hasOwnLocal =
              ownLocalRel.toLowerCase() !== attLower &&
              (indexedSet.has(ownLocalRel) ||
                (await this.exists(resolveInLibrary(this.libraryPath, ownLocalRel))));
            if (!hasOwnLocal && !(indexedResolved && indexedSet.has(attRel))) {
              pointsToCandidate = true;
              break;
            }
            if (indexedResolved && indexedResolved.toLowerCase() !== attLower) {
              continue;
            }
            pointsToCandidate = true;
            break;
          }

          // スラッシュを含む指定は、候補パス自体またはサブフォルダ/ローカル位置への一致を確認
          const mdResolved = resolveMarkdownRelPath(otherFolder, t);
          if (mdResolved && mdResolved.toLowerCase() === attLower) {
            pointsToCandidate = true;
            break;
          }
          if (attLower === norm.toLowerCase() || attLower.endsWith(`/${norm.toLowerCase()}`)) {
            const ownSubTarget = otherLocalSubfolder
              ? `${otherLocalSubfolder}/${fileName}`
              : fileName;
            if (
              norm.toLowerCase() === `${attSettings.folder.toLowerCase()}/${fileLower}` &&
              ownSubTarget.toLowerCase() !== attLower &&
              (await this.exists(resolveInLibrary(this.libraryPath, ownSubTarget)))
            ) {
              continue;
            }
            pointsToCandidate = true;
            break;
          }
        }

        if (pointsToCandidate) {
          shared.add(attRel);
        }
      }
    }

    return shared;
  }

  // 移動した文書の本文について、添付移動やフォルダ変更で切れるリンクを追従させる(#334)
  private rewriteMovedDocContent(
    content: string,
    oldDocPath: string,
    newDocPath: string,
    oldFolder: string,
    newFolder: string,
    attSettings: LibrarySettings['attachments'],
    movedAttMap: ReadonlyMap<string, string>,
    allKnownAttLower: ReadonlyMap<string, string>,
    docCandidateRels: ReadonlySet<string> | undefined,
    resolvePreIndexedWikilink: (target: string, fromDoc: string) => string | null,
    resolvePostWikilink: (target: string, fromDoc: string) => string | null,
  ): string {
    const { prefix, body } = splitFrontmatter(content);
    const oldSourceDir =
      attSettings.mode === 'same-folder'
        ? oldFolder
        : attSettings.mode === 'doc-subfolder'
          ? oldFolder
            ? `${oldFolder}/${attSettings.folder}`
            : attSettings.folder
          : null;

    const findKnownAtt = (rel: string): string | null => {
      if (movedAttMap.has(rel)) return rel;
      return allKnownAttLower.get(rel.toLowerCase()) ?? null;
    };

    const wikilinkRanges = computeCodeRanges(body);
    let working = body.replace(
      WIKILINK_REWRITE_RE,
      (full: string, open: string, rawTarget: string, close: string, offset: number): string => {
        if (isWithinCode(wikilinkRanges, offset + open.length)) return full;
        const { pathPart, suffix } = splitTargetSuffix(rawTarget);
        if (!pathPart || EXCLUDED_SCHEME_RE.test(pathPart)) return full;
        const norm = normalizeEmbedTarget(pathPart);
        if (!norm) return full;
        const ext = path.posix.extname(norm).toLowerCase();
        if (!DocService.ATTACHMENT_EXTENSIONS.has(ext)) return full;

        let preResolved: string | null = null;
        if (docCandidateRels && oldSourceDir !== null) {
          const base = path.posix.basename(norm);
          const candidateRel = oldSourceDir ? `${oldSourceDir}/${base}` : base;
          if (
            docCandidateRels.has(candidateRel) &&
            (!norm.includes('/') ||
              (attSettings.mode === 'doc-subfolder' &&
                norm.toLowerCase() ===
                  `${attSettings.folder.toLowerCase()}/${base.toLowerCase()}`) ||
              norm.toLowerCase() === candidateRel.toLowerCase())
          ) {
            preResolved = candidateRel;
          }
        }
        if (!preResolved) {
          preResolved = resolvePreIndexedWikilink(pathPart, oldDocPath);
        }
        if (!preResolved) return full;

        const expectedDest = movedAttMap.get(preResolved) ?? preResolved;
        if (resolvePostWikilink(pathPart, newDocPath) === expectedDest) {
          return full;
        }
        const nextTarget = resolveShortestEmbedTargetWith(
          newDocPath,
          expectedDest,
          resolvePostWikilink,
        );
        if (nextTarget === pathPart) return full;
        return `${open}${nextTarget}${suffix}${close}`;
      },
    );

    const mdRanges = computeCodeRanges(working);
    working = working.replace(
      MD_LINK_REWRITE_RE,
      (full: string, open: string, rawTarget: string, close: string, offset: number): string => {
        if (isWithinCode(mdRanges, offset + open.length)) return full;
        const { pathPart, suffix } = splitTargetSuffix(rawTarget);
        if (!pathPart || EXCLUDED_SCHEME_RE.test(pathPart)) return full;
        const ext = path.posix.extname(pathPart).toLowerCase();
        if (!DocService.ATTACHMENT_EXTENSIONS.has(ext)) return full;

        const preMd = resolveMarkdownRelPath(oldFolder, pathPart);
        let preResolved = preMd ? findKnownAtt(preMd) : null;
        if (
          !preResolved &&
          oldSourceDir !== null &&
          !pathPart.includes('/') &&
          open.startsWith('!') &&
          ext !== '.pdf'
        ) {
          const cand = oldSourceDir ? `${oldSourceDir}/${pathPart.trim()}` : pathPart.trim();
          preResolved = findKnownAtt(cand);
        }
        if (!preResolved) return full;

        const expectedDest = movedAttMap.get(preResolved) ?? preResolved;
        const keptResolved = resolveMarkdownRelPath(newFolder, pathPart);
        if (keptResolved === expectedDest) {
          return full;
        }
        const relFromNew = path.posix.relative(newFolder || '.', expectedDest);
        if (relFromNew === pathPart) return full;
        return `${open}${relFromNew}${suffix}${close}`;
      },
    );

    return prefix + working;
  }

  // ---- 添付(FR-IMG / FR-OBS-05) ----

  // 添付として受け付ける拡張子(画像 + PDF)。定義はlib/attachments.tsに集約
  // (indexer-serviceと共有するため)
  static readonly ATTACHMENT_EXTENSIONS = ATTACHMENT_EXTENSIONS;

  // PDFの命名に使う元ファイル名のstemを無害化する。
  //  - パス区切り・制御文字・Windows予約文字(\ / : * ? " < > |)を`_`に置換
  //  - 先頭のドット列を除去(`.hidden.pdf`が Unix 隠しファイル化するのを防ぐ。
  //    Obsidian でも `.` 始まりの添付は扱われない)
  //  - 結果が空なら 'document' にフォールバック
  private static sanitizePdfStem(originalName: string): string {
    const basename = path.posix.basename(originalName.normalize('NFC'));
    const stem = basename.slice(0, basename.length - path.posix.extname(basename).length);
    const sanitized = stem.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '');
    return sanitized === '' ? 'document' : sanitized;
  }

  // 画像・PDF添付の保存(FR-IMG-01/02/04)。保存先はライブラリ設定(未設定時は ATTACHMENT_DIR_MODE)により
  // 文書と同フォルダ / ライブラリ全体で1つのフォルダ / 文書フォルダ直下のサブフォルダ を切り替える(#160)
  async addAttachment(
    docPath: string,
    originalName: string,
    data: Buffer,
    author: GitAuthor,
  ): Promise<{ fileName: string; path: string; embedTarget: string }> {
    const docNorm = this.validateDocPath(docPath);
    if (!(await this.exists(resolveInLibrary(this.libraryPath, docNorm)))) {
      throw new DocNotFoundError(docNorm);
    }
    const ext = path.posix.extname(originalName.normalize('NFC')).toLowerCase();
    if (!DocService.ATTACHMENT_EXTENSIONS.has(ext)) {
      throw new InvalidPathError(originalName);
    }

    const attSettings = this.librarySettings
      ? (await this.librarySettings.get()).settings.attachments
      : attachmentSettingsFromEnv(this.config.attachmentDirMode);
    const docDirRaw = path.posix.dirname(docNorm);
    const docDir = docDirRaw === '.' ? '' : docDirRaw;
    let dirNorm: string;
    if (attSettings.mode === 'same-folder') {
      dirNorm = docDir;
    } else if (attSettings.mode === 'vault-folder') {
      dirNorm = attSettings.folder;
    } else {
      dirNorm = docDir ? `${docDir}/${attSettings.folder}` : attSettings.folder;
    }
    const absDir = dirNorm ? resolveInLibrary(this.libraryPath, dirNorm) : this.libraryPath;
    await mkdir(absDir, { recursive: true });

    // 画像はimage-YYYYMMDDHHmmss形式、PDFは元ファイル名尊重(Obsidian互換)。
    // いずれも衝突時は連番(要件05章5.1)
    let baseName: string;
    if (ext === '.pdf') {
      baseName = DocService.sanitizePdfStem(originalName);
    } else {
      const d = new Date();
      const p2 = (n: number) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      baseName = `image-${stamp}`;
    }
    let fileName = `${baseName}${ext}`;
    for (let i = 2; !(await this.writeExclusive(path.join(absDir, fileName), data)); i++) {
      fileName = `${baseName}-${i}${ext}`;
    }
    const relPath = dirNorm ? `${dirNorm}/${fileName}` : fileName;
    await this.tryCommit([relPath], `attach: ${relPath}`, author);
    // 添付索引に即時反映(issue #198。/api/embedで直後から解決できるように)
    await this.tryUpdateIndex(() => this.indexer.indexAttachment(relPath), { relPath }, '添付');
    const embedTarget = this.resolveShortestEmbedTarget(docNorm, relPath);
    return { fileName, path: relPath, embedTarget };
  }

  // 同名の別ファイル(例: 旧モードで同フォルダに保存された PDF)が /api/embed で優先される場合でも
  // 今回保存した添付を一意に解決できるよう、末尾からセグメントを増やして最短ターゲットを求める(#160)
  private resolveShortestEmbedTarget(docNorm: string, relPath: string): string {
    return resolveShortestEmbedTargetWith(docNorm, relPath, (candidate, from) =>
      this.indexer.resolveAttachment(candidate, from),
    );
  }

  // 添付パスとして妥当か検証して正規化する(保護パス・.trash・.md・非対応拡張子を拒否。
  // 対応拡張子は ATTACHMENT_EXTENSIONS = 画像 + PDF(#204)。issue #199)
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
      return (
        full: string,
        open: string,
        target: string,
        close: string,
        offset: number,
      ): string => {
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
    const rewrittenDocs: {
      path: string;
      updatedAt: string;
      replacements: { from: string; to: string }[];
    }[] = [];
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
    const manifestAbs = path.join(trashDir, TRASH_META_FILE);
    if (await this.exists(manifestAbs)) {
      await this.updateTrashFileManifest((manifest) => {
        delete manifest.items[trashName];
        removeCompanionPathFromManifest(manifest, `.trash/${trashName}`);
      });
    }
    await this.tryCommit([normalized, `.trash/${trashName}`], `trash: ${normalized}`, author);
    await this.tryUpdateIndex(
      async () => this.indexer.removeAttachment(normalized),
      { relPath: normalized },
      '添付',
    );
  }

  // ---- #333: 既存添付ファイルの一括整理・移行 ----

  private async loadLibrarySettingsForReorg(): Promise<LibrarySettings> {
    if (!this.librarySettings) {
      return {
        templates: { ...LIBRARY_SETTINGS_DEFAULTS.templates },
        dailyNotes: { ...LIBRARY_SETTINGS_DEFAULTS.dailyNotes },
        attachments: attachmentSettingsFromEnv(this.config.attachmentDirMode),
      };
    }
    const { settings, corrupted } = await this.librarySettings.get();
    if (corrupted) {
      throw new InvalidPathError(
        '.tsumiwiki/settings.yaml',
        '設定ファイル(.tsumiwiki/settings.yaml)が壊れているため整理を実行できません。設定を修復または保存し直してください',
      );
    }
    return settings;
  }

  private async buildReorgPlan(options?: { moveSharedToCommonFolder?: boolean }) {
    const settings = await this.loadLibrarySettingsForReorg();

    const rawAtts = (
      this.db.prepare('SELECT rel_path FROM attachment_index ORDER BY rel_path').all() as {
        rel_path: string;
      }[]
    ).map((r) => r.rel_path);
    const attachmentPaths: string[] = [];
    for (const rel of rawAtts) {
      if (isProtectedPath(rel) || rel.split('/').includes('.trash') || !isIndexedFileName(rel)) {
        continue;
      }
      if (await this.exists(resolveInLibrary(this.libraryPath, rel))) {
        attachmentPaths.push(rel);
      }
    }

    const rawDocs = (
      this.db.prepare('SELECT doc_path FROM doc_index ORDER BY doc_path').all() as {
        doc_path: string;
      }[]
    ).map((r) => r.doc_path);
    const docs: ReorgInputDoc[] = [];
    for (const docPath of rawDocs) {
      if (isProtectedPath(docPath) || docPath.split('/').includes('.trash')) continue;
      let content: string;
      try {
        content = await readFile(resolveInLibrary(this.libraryPath, docPath), 'utf8');
      } catch {
        continue;
      }
      const activeLock = this.locks.getActive(docPath);
      docs.push({
        docPath,
        content,
        lockedBy: activeLock
          ? { userId: activeLock.userId, displayName: activeLock.displayName }
          : null,
      });
    }

    return planAttachmentReorganization({
      attachmentPaths,
      docs,
      settings,
      moveSharedToCommonFolder: options?.moveSharedToCommonFolder ?? false,
      isOccupiedOnDisk: (relPath) => this.exists(resolveInLibrary(this.libraryPath, relPath)),
    });
  }

  async previewReorganizeAttachments(options?: {
    moveSharedToCommonFolder?: boolean;
  }): Promise<ReorganizePreviewResponse> {
    const plan = await this.buildReorgPlan(options);
    return plan.preview;
  }

  async reorganizeAttachments(
    options: { moveSharedToCommonFolder?: boolean },
    author: GitAuthor,
  ): Promise<ReorganizeExecuteResponse> {
    if (this.reorgInFlight) {
      throw new DocConflictError('添付ファイルの一括整理が既に実行中です');
    }
    this.reorgInFlight = true;
    try {
      const plan = await this.buildReorgPlan(options);
      if (plan.preview.lockedWarnings.length > 0) {
        const first = plan.preview.lockedWarnings[0];
        const holder = this.locks.getActive(first.docPath) ?? {
          userId: 0,
          displayName: first.displayName,
          acquiredAt: new Date().toISOString(),
          refreshedAt: new Date().toISOString(),
        };
        throw new DocLockedError(holder);
      }

      if (plan.preview.moves.length === 0 && plan.rewritesWithContent.length === 0) {
        return { moved: [], rewrittenDocs: [], skippedCount: plan.preview.skipped.length };
      }

      const moveStates: {
        fromPath: string;
        toPath: string;
        fromAbs: string;
        tmpAbs: string;
        toAbs: string;
        stage: 'at-from' | 'at-tmp' | 'at-to';
      }[] = plan.preview.moves.map((m) => {
        const fromAbs = resolveInLibrary(this.libraryPath, m.fromPath);
        const toAbs = resolveInLibrary(this.libraryPath, m.toPath);
        const tmpAbs = path.join(
          path.dirname(fromAbs),
          `.tsumiwiki-tmp-reorg-${randomBytes(6).toString('hex')}`,
        );
        return { fromPath: m.fromPath, toPath: m.toPath, fromAbs, tmpAbs, toAbs, stage: 'at-from' };
      });
      const docBackups: { docPath: string; docAbs: string; content: string }[] = [];
      const rewrittenDocs: ReorganizeExecuteResponse['rewrittenDocs'] = [];

      try {
        // Phase 1: 一旦固有の一時名へ退避し、スワップや大文字小文字のみの変更でも衝突を防ぐ
        for (const s of moveStates) {
          await this.moveFile(s.fromAbs, s.tmpAbs);
          s.stage = 'at-tmp';
        }
        // Phase 2: 一時名から最終移動先へリネーム
        for (const s of moveStates) {
          await mkdir(path.dirname(s.toAbs), { recursive: true });
          await this.moveFile(s.tmpAbs, s.toAbs);
          s.stage = 'at-to';
        }
        // Phase 3: 参照元文書のリンクをアトミックに書き換える(フロントマター・改行コード保持)
        for (const d of plan.rewritesWithContent) {
          const docAbs = resolveInLibrary(this.libraryPath, d.docPath);
          const latestLock = this.locks.getActive(d.docPath);
          if (latestLock) {
            throw new DocLockedError(latestLock);
          }
          let latestContent: string;
          try {
            latestContent = await readFile(docAbs, 'utf8');
          } catch {
            throw new DocConflictError(
              `一括整理の実行中に文書が削除または移動されたため中断しました: ${d.docPath}`,
            );
          }
          if (latestContent !== d.originalContent) {
            throw new DocConflictError(
              `一括整理の実行中に文書が更新されたため中断しました: ${d.docPath}`,
            );
          }
          docBackups.push({ docPath: d.docPath, docAbs, content: latestContent });
          await this.writeAtomic(docAbs, d.nextContent);
          const st = await stat(docAbs);
          rewrittenDocs.push({
            path: d.docPath,
            updatedAt: st.mtime.toISOString(),
            replacements: d.replacements,
          });
        }
      } catch (e) {
        for (let i = docBackups.length - 1; i >= 0; i--) {
          const b = docBackups[i];
          try {
            await this.writeAtomic(b.docAbs, b.content);
          } catch (rbErr) {
            this.logger?.error(
              { err: rbErr, docPath: b.docPath },
              '一括整理の文書ロールバックに失敗しました(手動復旧が必要)',
            );
          }
        }
        for (let i = moveStates.length - 1; i >= 0; i--) {
          const s = moveStates[i];
          if (s.stage !== 'at-to') continue;
          try {
            await this.moveFile(s.toAbs, s.tmpAbs);
            s.stage = 'at-tmp';
          } catch (rbErr) {
            this.logger?.error(
              { err: rbErr, fromPath: s.fromPath, toPath: s.toPath },
              '一括整理の移動先ロールバックに失敗しました(手動復旧が必要)',
            );
          }
        }
        for (let i = moveStates.length - 1; i >= 0; i--) {
          const s = moveStates[i];
          if (s.stage !== 'at-tmp') continue;
          try {
            await this.moveFile(s.tmpAbs, s.fromAbs);
            s.stage = 'at-from';
          } catch (rbErr) {
            this.logger?.error(
              { err: rbErr, fromPath: s.fromPath },
              '一括整理の一時ファイル復旧に失敗しました(手動復旧が必要)',
            );
          }
        }
        throw e;
      }

      const commitPaths = [
        ...plan.preview.moves.map((m) => m.fromPath),
        ...plan.preview.moves.map((m) => m.toPath),
        ...rewrittenDocs.map((d) => d.path),
      ];
      await this.tryCommit(
        commitPaths,
        `reorganize attachments: ${plan.preview.moves.length} files (${plan.preview.mode})`,
        author,
      );

      for (const m of plan.preview.moves) {
        await this.tryUpdateIndex(
          () => this.indexer.moveAttachment(m.fromPath, m.toPath),
          { oldRel: m.fromPath, newRel: m.toPath },
          '添付',
        );
      }
      for (const d of rewrittenDocs) {
        await this.tryUpdateIndex(
          () => this.indexer.indexFile(d.path),
          { docPath: d.path },
          '文書',
        );
      }

      return {
        moved: plan.preview.moves,
        rewrittenDocs,
        skippedCount: plan.preview.skipped.length,
      };
    } finally {
      this.reorgInFlight = false;
    }
  }

  // ---- ごみ箱(FR-DOC-07) ----

  private async readTrashFileManifest(): Promise<TrashFileManifest> {
    const manifestAbs = path.join(this.libraryPath, '.trash', TRASH_META_FILE);
    try {
      const raw = await readFile(manifestAbs, 'utf8');
      return parseTrashFileManifest(raw);
    } catch {
      return { version: 1, items: {} };
    }
  }

  private async updateTrashFileManifest(
    mutate: (manifest: TrashFileManifest) => void,
  ): Promise<void> {
    await this.trashManifestQueue.run(async () => {
      const trashDir = path.join(this.libraryPath, '.trash');
      const manifestAbs = path.join(trashDir, TRASH_META_FILE);
      const manifest = await this.readTrashFileManifest();
      mutate(manifest);
      if (Object.keys(manifest.items).length === 0) {
        await rm(manifestAbs, { force: true });
        return;
      }
      await mkdir(trashDir, { recursive: true });
      await this.writeAtomic(manifestAbs, `${JSON.stringify(manifest, null, 2)}\n`);
    });
  }

  // doc-subfolder の添付をすべて移動した後に空になったサブフォルダを docFolder 直前まで掃除する
  private async removeEmptySubdirsUpTo(subRel: string, stopParentRel: string): Promise<void> {
    let current = subRel;
    while (current && current !== stopParentRel) {
      const currentAbs = resolveInLibrary(this.libraryPath, current);
      try {
        const entries = await readdir(currentAbs);
        if (entries.length !== 0) break;
        await rmdir(currentAbs);
      } catch {
        break;
      }
      const parent = path.posix.dirname(current);
      current = parent === '.' ? '' : parent;
    }
  }

  // 復元先の同名衝突で添付が連番リネームされた場合のみ、復元した文書内の該当リンクを追従させる
  private rewriteRestoredDocAttachmentLinks(
    content: string,
    docDest: string,
    allAttPathsForPostIndex: string[],
    renamedAtts: { originalPath: string; destPath: string }[],
  ): string {
    if (renamedAtts.length === 0) return content;
    const { prefix, body } = splitFrontmatter(content);
    const docFolder = folderOfDoc(docDest);

    const preIndexRows = this.db.prepare('SELECT rel_path FROM attachment_index').all() as {
      rel_path: string;
    }[];
    const postPathSet = new Set<string>(preIndexRows.map((r) => r.rel_path));
    for (const p of allAttPathsForPostIndex) {
      postPathSet.add(p);
    }
    const postByName = buildByNameIndex([...postPathSet]);
    const resolvePostWikilink = (target: string, fromDoc: string): string | null =>
      resolveAttachmentFromByName(target, fromDoc, (b) => postByName.get(b) ?? []);

    const renamedByOldLower = new Map<string, { originalPath: string; destPath: string }>();
    for (const a of renamedAtts) {
      renamedByOldLower.set(a.originalPath.toLowerCase(), a);
    }

    const wikilinkRanges = computeCodeRanges(body);
    let working = body.replace(
      WIKILINK_REWRITE_RE,
      (full: string, open: string, rawTarget: string, close: string, offset: number): string => {
        if (isWithinCode(wikilinkRanges, offset + open.length)) return full;
        const { pathPart, suffix } = splitTargetSuffix(rawTarget);
        if (!pathPart || EXCLUDED_SCHEME_RE.test(pathPart)) return full;
        const norm = normalizeEmbedTarget(pathPart);
        if (!norm) return full;
        const ext = path.posix.extname(norm).toLowerCase();
        if (!DocService.ATTACHMENT_EXTENSIONS.has(ext)) return full;

        const normLower = norm.toLowerCase();
        let matched: { originalPath: string; destPath: string } | undefined;
        if (!norm.includes('/')) {
          matched = renamedAtts.find(
            (a) => path.posix.basename(a.originalPath).toLowerCase() === normLower,
          );
        } else {
          matched = renamedAtts.find((a) => {
            const origLower = a.originalPath.toLowerCase();
            return origLower === normLower || origLower.endsWith(`/${normLower}`);
          });
        }
        if (!matched) return full;

        const nextTarget = resolveShortestEmbedTargetWith(
          docDest,
          matched.destPath,
          resolvePostWikilink,
        );
        if (nextTarget === pathPart) return full;
        return `${open}${nextTarget}${suffix}${close}`;
      },
    );

    const mdRanges = computeCodeRanges(working);
    working = working.replace(
      MD_LINK_REWRITE_RE,
      (full: string, open: string, rawTarget: string, close: string, offset: number): string => {
        if (isWithinCode(mdRanges, offset + open.length)) return full;
        const { pathPart, suffix } = splitTargetSuffix(rawTarget);
        if (!pathPart || EXCLUDED_SCHEME_RE.test(pathPart)) return full;
        const ext = path.posix.extname(pathPart).toLowerCase();
        if (!DocService.ATTACHMENT_EXTENSIONS.has(ext)) return full;

        const resolvedMd = resolveMarkdownRelPath(docFolder, pathPart);
        let matched = resolvedMd ? renamedByOldLower.get(resolvedMd.toLowerCase()) : undefined;
        if (!matched && !pathPart.includes('/') && open.startsWith('!') && ext !== '.pdf') {
          const baseLower = pathPart.trim().toLowerCase();
          matched = renamedAtts.find(
            (a) => path.posix.basename(a.originalPath).toLowerCase() === baseLower,
          );
        }
        if (!matched) return full;

        const relFromDoc = path.posix.relative(docFolder || '.', matched.destPath);
        if (relFromDoc === pathPart) return full;
        return `${open}${relFromDoc}${suffix}${close}`;
      },
    );

    return prefix + working;
  }

  // .trash直下の項目パスとして検証する(ネスト・脱出・マニフェスト本体は拒否)
  private validateTrashLeaf(relPath: string): string {
    const normalized = normalizeRelPath(relPath);
    if (!/^\.trash\/[^/]+$/.test(normalized) || normalized === `.trash/${TRASH_META_FILE}`) {
      throw new InvalidPathError(relPath);
    }
    return normalized;
  }

  private async resolveTrashOriginFromGit(
    trashPath: string,
    isFolder: boolean,
  ): Promise<{ originalPath: string | null; deletedAt: string | null; deletedBy: string | null }> {
    let commit: Awaited<ReturnType<GitService['lastCommitWithBodyFor']>> = null;
    try {
      commit = await this.git.lastCommitWithBodyFor(trashPath);
    } catch (e) {
      this.logger?.warn({ err: e, trashPath }, 'ごみ箱項目の由来取得に失敗しました');
    }
    if (!commit) {
      return { originalPath: null, deletedAt: null, deletedBy: null };
    }
    const targetNfc = trashPath.normalize('NFC');
    if (!isFolder && commit.body) {
      for (const line of commit.body.split(/\r?\n/)) {
        if (!line.startsWith(TRASH_ATTACHMENT_TRAILER_PREFIX)) continue;
        try {
          const parsed = JSON.parse(line.slice(TRASH_ATTACHMENT_TRAILER_PREFIX.length)) as {
            trashPath?: unknown;
            originalPath?: unknown;
          };
          if (
            typeof parsed.trashPath === 'string' &&
            typeof parsed.originalPath === 'string' &&
            parsed.trashPath.normalize('NFC') === targetNfc
          ) {
            return {
              originalPath: parsed.originalPath,
              deletedAt: commit.date ?? null,
              deletedBy: commit.authorName ?? null,
            };
          }
        } catch {
          // 壊れたトレーラー行は無視して次のフォールバックへ進む
        }
      }
    }
    const m = commit.message.match(/^trash: (.+?)\/?$/);
    let originalPath: string | null = m ? m[1] : null;
    // 文書削除コミットに相乗りした添付でマニフェスト・トレーラーが共に無い場合、
    // 拡張子が異なる親文書パス(.md)へ画像等を復元して上書きしないようガードする
    if (!isFolder && originalPath) {
      const trashExt = path.posix.extname(targetNfc).toLowerCase();
      const origExt = path.posix.extname(originalPath).toLowerCase();
      if (trashExt !== origExt) {
        originalPath = null;
      }
    }
    return {
      originalPath,
      deletedAt: commit.date ?? null,
      deletedBy: commit.authorName ?? null,
    };
  }

  async listTrash(): Promise<TrashEntry[]> {
    const trashDir = path.join(this.libraryPath, '.trash');
    let entries;
    try {
      entries = await readdir(trashDir, { withFileTypes: true });
    } catch {
      return []; // .trash未作成
    }
    const visibleEntries = entries.filter((entry) => {
      const name = entry.name.normalize('NFC');
      return name !== TRASH_META_FILE && !name.startsWith('.tsumiwiki-tmp-');
    });
    const existingFileNames = new Set(
      visibleEntries.filter((e) => !e.isDirectory()).map((e) => e.name.normalize('NFC')),
    );
    const manifest = await this.readTrashFileManifest();

    // 親文書が .trash/ 内に存在する間は、同伴添付を一覧で重複表示しない(#161)。
    // 親文書が外部操作で消えた場合のみ、孤立添付を一覧に出して復元・掃除できるようにする。
    const hiddenCompanionPaths = new Set<string>();
    for (const [docTrashName, meta] of Object.entries(manifest.items)) {
      if (!existingFileNames.has(docTrashName)) continue;
      for (const att of meta.attachments ?? []) {
        hiddenCompanionPaths.add(att.trashPath.normalize('NFC'));
      }
    }

    const topLevelEntries = visibleEntries.filter((entry) => {
      if (entry.isDirectory()) return true;
      const trashPath = `.trash/${entry.name.normalize('NFC')}`;
      return !hiddenCompanionPaths.has(trashPath);
    });

    // 削除者・削除日時・元パスの取得方針:
    // - フォルダは `.trash/<name>/.tsumiwiki-trash.json` の由来メタデータを最優先で読む
    //   (空フォルダ削除でgitに差分が乗らずgit log経由の復元が効かない対策)
    // - 同伴添付付きファイル・孤立添付は `.trash/.tsumiwiki-trash.json` のマニフェスト(順引き/逆引き)を最優先で読む
    // - メタデータ不在時は trash: コミット(本文の Trashed-Attachment トレーラー含む)からの復元にフォールバック
    // - 項目単位で並列取得し、1項目のGitエラーで一覧全体を落とさない
    const result: TrashEntry[] = await Promise.all(
      topLevelEntries.map(async (entry) => {
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
        } else {
          const fileMeta = manifest.items[name];
          if (fileMeta) {
            const attachmentCount = (fileMeta.attachments ?? []).filter((a) =>
              existingFileNames.has(path.posix.basename(a.trashPath.normalize('NFC'))),
            ).length;
            return {
              trashPath,
              name,
              isFolder: false,
              originalPath: fileMeta.originalPath,
              deletedAt: fileMeta.deletedAt,
              deletedBy: fileMeta.deletedBy,
              ...(attachmentCount > 0 ? { attachmentCount } : {}),
            };
          }
          const companion = findCompanionInManifest(manifest, trashPath);
          if (companion) {
            return {
              trashPath,
              name,
              isFolder: false,
              originalPath: companion.att.originalPath,
              deletedAt: companion.docMeta.deletedAt,
              deletedBy: companion.docMeta.deletedBy,
            };
          }
        }
        const gitOrigin = await this.resolveTrashOriginFromGit(trashPath, isFolder);
        return {
          trashPath,
          name,
          isFolder,
          originalPath: gitOrigin.originalPath,
          deletedAt: gitOrigin.deletedAt,
          deletedBy: gitOrigin.deletedBy,
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

    const trashName = path.posix.basename(normalized);
    let fileMeta: TrashFileMeta | null = null;
    let companionRef: ReturnType<typeof findCompanionInManifest> = null;
    // フォルダは由来メタデータを最優先で読む(空フォルダ削除の対策。上記listTrashと同方針)
    let original: string | null = null;
    if (isFolder) {
      const meta = await readTrashMeta(abs);
      if (meta) original = meta.originalPath;
    } else {
      const manifest = await this.readTrashFileManifest();
      fileMeta = manifest.items[trashName] ?? null;
      if (fileMeta) {
        original = fileMeta.originalPath;
      } else {
        companionRef = findCompanionInManifest(manifest, normalized);
        if (companionRef) {
          original = companionRef.att.originalPath;
        }
      }
    }
    if (!original) {
      // ファイル、またはメタデータ不在時は trash: コミット(トレーラー含む)からの復元にフォールバック
      const gitOrigin = await this.resolveTrashOriginFromGit(normalized, isFolder);
      // 元パス不明(手動で.trashに置かれた等)ならルート直下へ戻す
      original = gitOrigin.originalPath ?? trashName;
    }

    // 元パスが不正(..等の細工コミット)な場合もbasenameへフォールバックする
    // (先にnormalizeで例外を出すと復元不能になるため、正規化はtryで包む)
    let dest: string;
    try {
      dest = normalizeRelPath(original);
    } catch {
      dest = trashName;
    }
    if (!dest || isProtectedPath(dest) || dest.split('/').includes('.trash')) {
      dest = trashName;
    }
    // 復元先の衝突は連番で回避(existsチェック→renameの間の競合は
    // 実運用頻度が低く許容。Gitコミット自体は直列キューで保護される)
    const ext = isFolder ? '' : path.posix.extname(dest);
    const stem = ext ? dest.slice(0, dest.length - ext.length) : dest;
    for (let i = 2; await this.exists(resolveInLibrary(this.libraryPath, dest)); i++) {
      dest = `${stem} (${i})${ext}`;
    }

    const destAbs = resolveInLibrary(this.libraryPath, dest);

    // 同伴添付の復元計画(#161)
    interface RestoredAttPlan {
      trashPath: string;
      trashAbs: string;
      originalPath: string;
      destPath: string;
      destAbs: string;
      renamed: boolean;
    }
    const attPlans: RestoredAttPlan[] = [];
    if (!isFolder && fileMeta?.attachments?.length) {
      const claimedDestLower = new Set<string>([dest.toLowerCase()]);
      for (const att of fileMeta.attachments) {
        let attTrashNorm: string;
        try {
          attTrashNorm = this.validateTrashLeaf(att.trashPath);
        } catch {
          continue;
        }
        const attTrashAbs = resolveInLibrary(this.libraryPath, attTrashNorm);
        if (!(await this.exists(attTrashAbs))) {
          this.logger?.warn(
            { trashPath: normalized, missingAttachment: attTrashNorm },
            '復元対象の同伴添付ファイルが見つかりませんでした(スキップ)',
          );
          continue;
        }
        const attTrashBase = path.posix.basename(attTrashNorm);
        let attOriginal: string;
        try {
          attOriginal = normalizeRelPath(att.originalPath);
        } catch {
          attOriginal = attTrashBase;
        }
        if (
          !attOriginal ||
          isProtectedPath(attOriginal) ||
          attOriginal.split('/').includes('.trash')
        ) {
          attOriginal = attTrashBase;
        }
        const attExt = path.posix.extname(attOriginal);
        const attStem = attExt
          ? attOriginal.slice(0, attOriginal.length - attExt.length)
          : attOriginal;
        let attDest = attOriginal;
        for (
          let i = 2;
          claimedDestLower.has(attDest.toLowerCase()) ||
          (await this.exists(resolveInLibrary(this.libraryPath, attDest)));
          i++
        ) {
          attDest = `${attStem} (${i})${attExt}`;
        }
        claimedDestLower.add(attDest.toLowerCase());
        attPlans.push({
          trashPath: attTrashNorm,
          trashAbs: attTrashAbs,
          originalPath: attOriginal,
          destPath: attDest,
          destAbs: resolveInLibrary(this.libraryPath, attDest),
          renamed: attDest !== attOriginal,
        });
      }
    }

    const movedBack: { fromAbs: string; toAbs: string }[] = [];
    try {
      await mkdir(path.dirname(destAbs), { recursive: true });
      await this.moveFile(abs, destAbs);
      movedBack.push({ fromAbs: abs, toAbs: destAbs });
      for (const a of attPlans) {
        await mkdir(path.dirname(a.destAbs), { recursive: true });
        await this.moveFile(a.trashAbs, a.destAbs);
        movedBack.push({ fromAbs: a.trashAbs, toAbs: a.destAbs });
      }
    } catch (e) {
      for (const m of [...movedBack].reverse()) {
        try {
          await this.moveFile(m.toAbs, m.fromAbs);
        } catch (rbErr) {
          this.logger?.error(
            { err: rbErr, from: m.toAbs, to: m.fromAbs },
            'ごみ箱復元のロールバックに失敗しました',
          );
        }
      }
      throw e;
    }

    // 復元先で添付が同名衝突により連番リネームされた場合は、復元文書内のリンクも追従させる
    const renamedAtts = attPlans.filter((a) => a.renamed);
    if (!isFolder && dest.toLowerCase().endsWith('.md') && renamedAtts.length > 0) {
      try {
        const restoredContent = await readFile(destAbs, 'utf8');
        const rewritten = this.rewriteRestoredDocAttachmentLinks(
          restoredContent,
          dest,
          attPlans.map((a) => a.destPath),
          renamedAtts,
        );
        if (rewritten !== restoredContent) {
          await this.writeAtomic(destAbs, rewritten);
        }
      } catch (e) {
        this.logger?.warn(
          { err: e, dest },
          '復元文書の添付リンク書き換えに失敗しました(復元自体は完了)',
        );
      }
    }

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
    } else if (fileMeta || companionRef) {
      let existingNames = new Set<string>();
      try {
        const entries = await readdir(path.join(this.libraryPath, '.trash'), {
          withFileTypes: true,
        });
        existingNames = new Set(
          entries.filter((e) => !e.isDirectory()).map((e) => e.name.normalize('NFC')),
        );
      } catch {
        // .trash が無ければ空集合で扱う
      }
      await this.updateTrashFileManifest((m) => {
        if (fileMeta) {
          delete m.items[trashName];
        }
        if (companionRef) {
          removeCompanionPathFromManifest(m, normalized, existingNames);
        }
      });
    }

    const commitPaths = [normalized, dest, ...attPlans.flatMap((a) => [a.trashPath, a.destPath])];
    await this.tryCommit(commitPaths, `untrash: ${dest}${isFolder ? '/' : ''}`, author);
    if (isFolder) {
      await this.tryUpdateIndex(() => this.indexer.scanAll(), { dest }, 'フォルダ配下の全走査');
    } else if (dest.toLowerCase().endsWith('.md')) {
      await this.tryUpdateIndex(() => this.indexer.indexFile(dest), { path: dest }, '文書');
    } else if (isIndexedFileName(dest)) {
      await this.tryUpdateIndex(() => this.indexer.indexAttachment(dest), { dest }, '添付');
    }
    for (const a of attPlans) {
      if (isIndexedFileName(a.destPath)) {
        await this.tryUpdateIndex(
          () => this.indexer.indexAttachment(a.destPath),
          { dest: a.destPath },
          '添付',
        );
      }
    }
    return { path: dest };
  }

  // ごみ箱からの完全削除(admin専用。ファイルは消えるがGit履歴には残る)
  async purgeTrash(trashPath: string, author: GitAuthor): Promise<void> {
    const normalized = this.validateTrashLeaf(trashPath);
    const abs = resolveInLibrary(this.libraryPath, normalized);
    let isFolder: boolean;
    try {
      isFolder = (await stat(abs)).isDirectory();
    } catch {
      throw new DocNotFoundError(normalized);
    }
    const trashName = path.posix.basename(normalized);
    const commitPaths = [normalized];
    let fileMeta: TrashFileMeta | null = null;
    let companionRef: ReturnType<typeof findCompanionInManifest> = null;
    const companionTargets: { trashNorm: string; abs: string }[] = [];
    if (!isFolder) {
      const manifest = await this.readTrashFileManifest();
      fileMeta = manifest.items[trashName] ?? null;
      if (fileMeta) {
        for (const att of fileMeta.attachments ?? []) {
          let attTrashNorm: string;
          try {
            attTrashNorm = this.validateTrashLeaf(att.trashPath);
          } catch {
            continue;
          }
          const attAbs = resolveInLibrary(this.libraryPath, attTrashNorm);
          if (await this.exists(attAbs)) {
            companionTargets.push({ trashNorm: attTrashNorm, abs: attAbs });
          }
        }
      } else {
        companionRef = findCompanionInManifest(manifest, normalized);
      }
    }
    // 親本体を先に削除し、親の削除失敗時に同伴添付だけが失われる不整合を防ぐ
    await rm(abs, { recursive: true, force: true });
    for (const target of companionTargets) {
      await rm(target.abs, { force: true });
      commitPaths.push(target.trashNorm);
    }
    if (fileMeta || companionRef) {
      let existingNames = new Set<string>();
      try {
        const entries = await readdir(path.join(this.libraryPath, '.trash'), {
          withFileTypes: true,
        });
        existingNames = new Set(
          entries.filter((e) => !e.isDirectory()).map((e) => e.name.normalize('NFC')),
        );
      } catch {
        // .trash が無ければ空集合で扱う
      }
      await this.updateTrashFileManifest((m) => {
        if (fileMeta) {
          delete m.items[trashName];
        }
        if (companionRef) {
          removeCompanionPathFromManifest(m, normalized, existingNames);
        }
      });
    }
    await this.tryCommit(commitPaths, `purge: ${normalized}`, author);
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
    await this.tryUpdateIndex(
      () => this.indexer.indexFile(normalized),
      { path: normalized },
      '文書',
    );
    this.drafts.removeOwn(normalized, userId);
    const after = await stat(abs);
    return { updatedAt: after.mtime.toISOString() };
  }

  // MCP経由の履歴復元(#312)。UI編集ロックの保持は要求しない代わりに、誰かが保持中なら拒否する
  // (saveDocMcp と同じ)。過去版はコミット済みで変わらないため列の外で先に取得し、
  // 書き込みは追記・部分置換と同じ列で行う。restoreDoc と同じく内容はバイト単位でそのまま書き戻す
  // (LF統一・updated更新なし)。下書きは触らない(MCPには呼び出しユーザーがいないため)
  async restoreDocMcp(
    relPath: string,
    rev: string,
    author: GitAuthor,
    baseUpdatedAt?: string,
  ): Promise<{ path: string; updatedAt: string }> {
    const normalized = this.validateDocPath(relPath);
    const content = await this.contentAt(normalized, rev);
    const { updatedAt } = await this.serializedMcpEdit(normalized, author, baseUpdatedAt, () => ({
      body: '',
      rawContent: content,
      commitMessage: `restore: ${normalized} @${rev.slice(0, 7).toLowerCase()}`,
    }));
    return { path: normalized, updatedAt };
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
    // 移動元はフォルダに限る(ファイルを渡すと拡張子の検査を通らずに改名できてしまうため)。
    // ファイルは「その名前のフォルダは無い」として扱う
    if (!(await this.isDirectory(oldAbs))) {
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
    await this.tryUpdateIndex(
      () => this.indexer.scanAll(),
      { path: normalized },
      'フォルダ配下の全走査',
    );
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

  private async isDirectory(abs: string): Promise<boolean> {
    try {
      return (await stat(abs)).isDirectory();
    } catch {
      return false;
    }
  }
}
