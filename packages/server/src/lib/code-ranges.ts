// フェンス行(3文字以上の```/~~~連。インデントのみのコードブロックは対象外)の検出。
// markdown-meta.tsのstripCode(タグ抽出用)と同じ簡易な行単位の状態機械を、
// 位置(文字インデックス)を保った形で使うためにここで定義する
const CODE_FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;
// インラインコード(`...`・``...``等)。バッククォート連長が一致するスパンを1行内で検出
const INLINE_CODE_SPAN_RE = /(`+).*?\1/g;

export interface CodeRange {
  start: number;
  end: number;
}

/**
 * body中の「コードブロック・インラインコードの内側」の文字範囲([start, end))を返す。
 * extractLinkTargets/rewriteAttachmentReferences/extractDocLinksはこの範囲内の記法を対象外にする
 */
export function computeCodeRanges(body: string): CodeRange[] {
  const ranges: CodeRange[] = [];
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

export function isWithinCode(ranges: CodeRange[], index: number): boolean {
  return ranges.some((r) => index >= r.start && index < r.end);
}
