import matter from 'gray-matter';

// 文書メタデータの抽出(設計02章2.3 / FR-OBS-06)
// - フロントマター: gray-matterで寛容にパース(壊れたYAMLでも文書自体は索引する)
// - インラインタグ: Obsidian規則に準拠(行頭または空白直後の #タグ。
//   コードブロック・インラインコード内は除外。数字のみのタグは無効)

export interface DocMeta {
  frontmatterTags: string[];
  inlineTags: string[];
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
    body,
  };
}
