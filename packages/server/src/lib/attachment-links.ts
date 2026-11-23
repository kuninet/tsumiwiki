import path from 'node:path';
import { computeCodeRanges, isWithinCode } from './code-ranges.js';
import { normalizeRelPath } from './paths.js';

// フロントマターブロック(開始〜終了フェンス)の抽出用
export const FM_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

// フロントマターブロックと本文を厳密に分離する(フロントマターに触れず本文のみを書き戻す用)
export function splitFrontmatter(content: string): { prefix: string; body: string } {
  const m = FM_BLOCK_RE.exec(content);
  return m ? { prefix: m[0], body: content.slice(m[0].length) } : { prefix: '', body: content };
}

// #199 / #333: 参照検出・書き換えが共用する正規表現。target 部分だけを差し替えられるよう
// 開き記法・target・閉じ記法(alias/anchor/title)を別グループに分離する。
export const WIKILINK_REWRITE_RE = /(!?\[\[)([^\]|#\n]+?)((?:[#|][^\]\n]*)?\]\])/g;
export const MD_LINK_REWRITE_RE = /(!?\[[^\]\n]*\]\()([^)\s\n]+)((?:\s+["'][^)\n]*)?\))/g;
export const EXCLUDED_SCHEME_RE = /^(https?|data|mailto|file):/i;

// target の `?`/`#` 以降(クエリ・アンカー)を切り離す。前後空白は trim する。
export function splitTargetSuffix(rawTarget: string): { pathPart: string; suffix: string } {
  const trimmed = rawTarget.trim();
  const cut = trimmed.search(/[?#]/);
  return cut === -1
    ? { pathPart: trimmed, suffix: '' }
    : { pathPart: trimmed.slice(0, cut), suffix: trimmed.slice(cut) };
}

// 本文中のコードブロック・インラインコード外のリンク target 一覧を抽出する(#199)
export interface LinkRef {
  target: string;
  // 標準 Markdown 記法(`[](...)` / `![](...)`)か。false は Wikilink(`[[...]]` / `![[...]]`)
  markdown: boolean;
}

// 本文中のコードブロック・インラインコード外のリンク参照を出現順に抽出する。
// embedsOnly: true なら埋め込み(`![[...]]` / `![](...)`)だけを対象にする(#345)。
// リンク付き画像 `[![alt](a.png)](https://x)` は MD_LINK_REWRITE_RE が外側の `[` から
// マッチし m[1] が `[![alt](` になるため、alt 部分に `![` を含む場合も埋め込みとみなす
function collectLinkRefs(body: string, embedsOnly: boolean): LinkRef[] {
  const ranges = computeCodeRanges(body);
  const result: LinkRef[] = [];
  const seen = new Set<string>();
  const consider = (m: RegExpMatchArray, markdown: boolean) => {
    if (embedsOnly && !m[1].startsWith('!') && !(markdown && m[1].slice(1, -2).includes('!['))) {
      return;
    }
    const offset = (m.index ?? 0) + m[1].length;
    if (isWithinCode(ranges, offset)) return;
    const { pathPart } = splitTargetSuffix(m[2]);
    if (!pathPart) return;
    if (EXCLUDED_SCHEME_RE.test(pathPart)) return;
    const key = `${markdown ? 'm' : 'w'}:${pathPart}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ target: pathPart, markdown });
  };
  for (const m of body.matchAll(WIKILINK_REWRITE_RE)) consider(m, false);
  for (const m of body.matchAll(MD_LINK_REWRITE_RE)) consider(m, true);
  return result;
}

// 本文中のコードブロック・インラインコード外のリンク target 一覧を抽出する(#199)
export function extractLinkTargets(body: string, options?: { embedsOnly?: boolean }): string[] {
  return [...new Set(collectLinkRefs(body, options?.embedsOnly ?? false).map((r) => r.target))];
}

// 埋め込み(`![[...]]` / `![](...)`)の参照を、記法の種別つきで抽出する(#345)
export function extractEmbedRefs(body: string): LinkRef[] {
  return collectLinkRefs(body, true);
}

// URI エンコード済みのパスをセグメント単位で安全にデコードする
// (クライアントの resolveImageSrc と同じ。不正なエスケープはそのまま残す)
export function decodeUriPathSegments(rawPath: string): string {
  return rawPath
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

export interface AttachmentCandidate {
  rel_path: string;
  folder: string;
}

// target 文字列の正規化。NFC・前後空白除去・\→/・先頭の ./ と / を除去。
// 空、または .. セグメントを含む場合は null
export function normalizeEmbedTarget(target: string): string | null {
  const unified = target
    .normalize('NFC')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '');
  if (!unified) return null;
  const segments = unified.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0 || segments.some((s) => s === '..')) return null;
  return segments.join('/');
}

// fromDocPath の親フォルダ('' = ルート)。空・不正な入力は '' 扱い
export function folderOfDoc(fromDocPath: string): string {
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

// 複数候補から 1 件を優先順位で絞り込む(#198)
export function pickBestAttachmentCandidate(
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

// basenameLower で絞り込まれた候補列を使って /api/embed と同一規則で解決する純粋関数
export function resolveAttachmentFromByName(
  target: string,
  fromDocPath: string,
  getByName: (basenameLower: string) => AttachmentCandidate[],
): string | null {
  const normalizedTarget = normalizeEmbedTarget(target);
  if (!normalizedTarget) return null;
  const fromFolder = folderOfDoc(fromDocPath);
  const hasPath = normalizedTarget.includes('/');
  const targetLower = normalizedTarget.toLowerCase();
  const basenameLower = path.posix.basename(normalizedTarget).toLowerCase();

  const byName = getByName(basenameLower);
  const candidates = hasPath
    ? byName.filter((c) => {
        const relLower = c.rel_path.toLowerCase();
        return relLower === targetLower || relLower.endsWith(`/${targetLower}`);
      })
    : byName;

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].rel_path;
  const isExactPath = hasPath
    ? (relPath: string) => relPath.toLowerCase() === targetLower
    : () => false;
  return pickBestAttachmentCandidate(fromFolder, candidates, isExactPath);
}

// 末尾セグメントから広げて一意解決できる最短ターゲットを返す(#160 / #333)
export function resolveShortestEmbedTargetWith(
  docNorm: string,
  relPath: string,
  resolve: (target: string, from: string) => string | null,
): string {
  const parts = relPath.split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = parts.slice(i).join('/');
    if (resolve(candidate, docNorm) === relPath) {
      return candidate;
    }
  }
  return relPath;
}

// 標準 Markdown リンクの相対パスを文書フォルダ基準で正規化する(#333 / #334)。
// 先頭 '/' はライブラリルート基準とし、'..' でルート外に出る場合は null を返す。
export function resolveMarkdownRelPath(docFolder: string, rawPathPart: string): string | null {
  const unified = rawPathPart.normalize('NFC').replaceAll('\\', '/');
  const isRoot = unified.startsWith('/');
  const baseParts = isRoot || !docFolder ? [] : docFolder.split('/');
  const relParts = unified.split('/');
  const stack = [...baseParts];
  for (const seg of relParts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  if (stack.length === 0) return null;
  return stack.join('/');
}

export function buildByNameIndex(paths: string[]): Map<string, AttachmentCandidate[]> {
  const byName = new Map<string, AttachmentCandidate[]>();
  for (const relPath of paths) {
    const name = path.posix.basename(relPath);
    const nameKey = name.toLowerCase();
    const dir = path.posix.dirname(relPath);
    const folder = dir === '.' ? '' : dir;
    const list = byName.get(nameKey);
    const entry: AttachmentCandidate = { rel_path: relPath, folder };
    if (list) list.push(entry);
    else byName.set(nameKey, [entry]);
  }
  return byName;
}
