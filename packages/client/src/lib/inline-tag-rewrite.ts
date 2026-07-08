// 本文中のインラインタグ(#tag)を改名/削除するユーティリティ。
// タグ抽出ロジックはサーバ側 packages/server/src/services/markdown-meta.ts と揃える:
// - タグ文字集合: /[\p{L}\p{N}_/-]+/u
// - 直前は行頭または空白/開き括弧のいずれか
// - コードブロック(```/~~~)・インラインコード(`…`)内は書き換え対象外

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
// サーバ側 packages/server/src/services/markdown-meta.ts の `stripCode` と挙動を揃える(`(`+).*?\1`)。
// [^`]*? を使うと二重バッククォート span 内に単一バッククォートを含むケースで parse がズレる
const INLINE_CODE_RE = /(`+).*?\1/g;
const TAG_SUFFIX_BOUNDARY = String.raw`(?![\p{L}\p{N}_/-])`;

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildTagRegex(name: string): RegExp {
  return new RegExp(
    String.raw`(^|[\s(])#${escapeRegex(name)}${TAG_SUFFIX_BOUNDARY}`,
    'gu',
  );
}

// 行内のインラインコード外の部分だけを rewrite に通す
function rewriteOutsideInlineCode(line: string, rewrite: (chunk: string) => string): string {
  const parts: string[] = [];
  let last = 0;
  INLINE_CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_CODE_RE.exec(line))) {
    parts.push(rewrite(line.slice(last, m.index)));
    parts.push(m[0]);
    last = m.index + m[0].length;
  }
  parts.push(rewrite(line.slice(last)));
  return parts.join('');
}

// 本文全体を、コードフェンス外の行についてのみ line-rewriter で書き換える。
// 未クローズのフェンスは末尾まで書き換え対象外(タグ誤書き換えより取りこぼしを優先)
function rewriteOutsideCodeBlocks(body: string, rewrite: (chunk: string) => string): string {
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
      out.push(line);
      continue;
    }
    if (m) {
      fence = { char: m[1][0], len: m[1].length };
      out.push(line);
      continue;
    }
    out.push(rewriteOutsideInlineCode(line, rewrite));
  }
  return out.join('\n');
}

export function renameInlineTag(body: string, oldName: string, newName: string): string {
  if (!oldName || !newName || oldName === newName) return body;
  const re = buildTagRegex(oldName);
  return rewriteOutsideCodeBlocks(body, (chunk) =>
    chunk.replace(re, (_match, prefix) => `${prefix}#${newName}`),
  );
}

export function removeInlineTag(body: string, name: string): string {
  if (!name) return body;
  const re = buildTagRegex(name);
  return rewriteOutsideCodeBlocks(body, (chunk) =>
    chunk.replace(re, (_match, prefix) => prefix),
  );
}
