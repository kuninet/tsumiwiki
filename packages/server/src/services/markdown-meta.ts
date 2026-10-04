import matter from 'gray-matter';
import { parseWikilinkTarget } from '@tsumiwiki/shared';
import { computeCodeRanges, isWithinCode } from '../lib/code-ranges.js';

// 文書メタデータの抽出(設計02章2.3 / FR-OBS-06)
// - フロントマター: gray-matterで寛容にパース(壊れたYAMLでも文書自体は索引する)
// - インラインタグ: Obsidian規則に準拠(行頭または空白直後の #タグ。
//   コードブロック・インラインコード内は除外。数字のみのタグは無効)
// - 文書間リンク: [[文書名]] (コードブロック・インラインコード内は除外、![[...]]埋め込みは除く)

export interface ExtractedLink {
  seq: number;
  targetRaw: string;
  targetNorm: string;
  targetKey: string;
  anchor: string | null;
  alias: string | null;
  line: number;
  context: string;
}

export interface DocMeta {
  frontmatterTags: string[];
  inlineTags: string[];
  links: ExtractedLink[];
  body: string; // フロントマターを除いた本文(FTS用)
}

// タグに使える文字: Unicode文字・数字・アンダースコア・ハイフン・スラッシュ(階層)
const INLINE_TAG_RE = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gmu;

// フロントマターのtagsを配列に正規化(配列 / カンマ区切り文字列 / 単一文字列を許容)
function normalizeFrontmatterTags(value: unknown): string[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\s]+/)
      : [];
  return raw
    .filter((t): t is string | number => typeof t === 'string' || typeof t === 'number')
    .map((t) => String(t).trim().replace(/^#/, '').normalize('NFC'))
    .filter((t) => t.length > 0);
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

// コードブロックとインラインコードを除去してからタグ抽出する。
// 行単位の状態機械で処理する:
// - フェンスは3文字以上の `/~ 連。閉じは同種・同長以上かつ後続が空白のみの行
// - 未クローズのフェンスは文書末尾まで除外(タグの誤検出より取りこぼしを優先)
// - インラインコードはバッククォート連長が一致するスパン(``〜`` 等)を除去
function stripCode(body: string): string {
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of body.split('\n')) {
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (
        m &&
        m[1][0] === fence.char &&
        m[1].length >= fence.len &&
        /^\s*$/.test(line.slice(m[0].length))
      ) {
        fence = null;
      }
      continue;
    }
    if (m) {
      fence = { char: m[1][0], len: m[1].length };
      continue;
    }
    out.push(line.replace(/(`+).*?\1/g, ' '));
  }
  return out.join('\n');
}

// 壊れたフロントマターのフェンス部分だけを取り除く(本文は索引対象として保持)
function stripBrokenFrontmatter(content: string): string {
  if (!/^---\r?\n/.test(content)) return content;
  const m = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  return m ? content.slice(m[0].length) : content;
}

function extractInlineTags(body: string): string[] {
  const tags = new Set<string>();
  const stripped = stripCode(body);
  for (const m of stripped.matchAll(INLINE_TAG_RE)) {
    const tag = m[2];
    // 数字のみのタグは無効(Obsidian準拠。#123 など)
    if (/^[\p{N}/]+$/u.test(tag)) continue;
    // 末尾のスラッシュ・ハイフンは除去。タグもNFCに正規化して重複を防ぐ
    const cleaned = tag.replace(/[/-]+$/, '').normalize('NFC');
    if (cleaned) tags.add(cleaned);
  }
  return [...tags];
}

function extractContext(
  lines: string[],
  lineIndex: number,
  colIndex: number,
  linkLength: number,
): string {
  const line = lines[lineIndex] ?? '';
  if (line.length <= 200) {
    let ctx = line;
    if (lineIndex > 0) {
      const prev = lines[lineIndex - 1];
      if (prev.length + 1 + ctx.length <= 200) {
        ctx = prev + '\n' + ctx;
      }
    }
    if (lineIndex < lines.length - 1) {
      const next = lines[lineIndex + 1];
      if (ctx.length + 1 + next.length <= 200) {
        ctx = ctx + '\n' + next;
      }
    }
    return ctx.trim();
  }
  const start = Math.max(0, colIndex - 60);
  const end = Math.min(line.length, colIndex + linkLength + 60);
  let snippet = line.slice(start, end).trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < line.length) snippet = snippet + '...';
  return snippet.slice(0, 200);
}

const WIKILINK_EXTRACT_RE = /(?<!\!)\[\[([^\[\]\r\n]+)\]\]/g;

export function extractDocLinks(body: string): ExtractedLink[] {
  const codeRanges = computeCodeRanges(body);
  const links: ExtractedLink[] = [];

  const lineOffsets: number[] = [0];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\n') {
      lineOffsets.push(i + 1);
    }
  }
  const lines = body.split('\n');

  let seq = 0;
  for (const m of body.matchAll(WIKILINK_EXTRACT_RE)) {
    const offset = m.index ?? 0;
    if (isWithinCode(codeRanges, offset)) continue;

    const inner = m[1];
    const pipeIdx = inner.indexOf('|');
    const rawBeforePipe = pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner;
    const alias = pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() || null : null;
    const targetRaw = rawBeforePipe.trim();

    const meta = parseWikilinkTarget(targetRaw);
    if (meta.isInternal || !meta.target) continue;

    let l = 0;
    let r = lineOffsets.length - 1;
    while (l <= r) {
      const mid = (l + r) >> 1;
      if (lineOffsets[mid] <= offset) {
        l = mid + 1;
      } else {
        r = mid - 1;
      }
    }
    const lineIndex = r;
    const lineNum = lineIndex + 1;
    const colIndex = offset - lineOffsets[lineIndex];

    const context = extractContext(lines, lineIndex, colIndex, m[0].length);

    links.push({
      seq: seq++,
      targetRaw,
      targetNorm: meta.target,
      targetKey: meta.targetKey,
      anchor: meta.anchor || null,
      alias,
      line: lineNum,
      context,
    });
  }

  return links;
}

export function parseDocMeta(content: string): DocMeta {
  let body = content;
  let frontmatterTags: string[] = [];
  try {
    const parsed = matter(content);
    body = parsed.content;
    frontmatterTags = normalizeFrontmatterTags(
      (parsed.data as Record<string, unknown>).tags ?? (parsed.data as Record<string, unknown>).tag,
    );
  } catch {
    // 壊れたフロントマターはタグなし扱いとし、フェンス部分を除いた本文を索引する(寛容パース)
    body = stripBrokenFrontmatter(content);
  }
  return {
    frontmatterTags,
    inlineTags: extractInlineTags(body),
    links: extractDocLinks(body),
    body,
  };
}
