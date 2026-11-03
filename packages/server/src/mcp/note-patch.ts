export interface PatchEdit {
  oldText: string;
  newText: string;
}

export type PatchErrorPayload =
  | { code: 'PATCH_NOT_FOUND'; message: string; editIndex: number }
  | { code: 'PATCH_AMBIGUOUS'; message: string; editIndex: number; occurrences: number }
  | { code: 'PATCH_OVERLAP'; message: string; editIndexes: [number, number] }
  | { code: 'PATCH_FRONTMATTER'; message: string };

export class NotePatchError extends Error {
  readonly payload: PatchErrorPayload;

  constructor(payload: PatchErrorPayload) {
    super(payload.message);
    this.name = 'NotePatchError';
    this.payload = payload;
  }
}

/**
 * 文字列中の検索対象の出現回数と最初の出現位置を返す。
 * 重なり出現(例: "aaaa" 中の "aa")も正しく数えるため、次検索位置は pos + 1 で進める。
 */
export function countOccurrences(
  haystack: string,
  needle: string,
): { first: number; count: number } {
  if (needle.length === 0) {
    return { first: -1, count: 0 };
  }
  let count = 0;
  let first = -1;
  let pos = 0;
  while (pos <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    if (count === 0) first = idx;
    count++;
    pos = idx + 1;
  }
  return { first, count };
}

interface LocatedEdit {
  index: number;
  start: number;
  end: number;
  oldText: string;
  newText: string;
}

/**
 * 本文に対して複数の部分置換をアトミックに適用する。
 * 改行を \n に正規化し、すべての edit が本文中にちょうど1回現れることを確認後、
 * 範囲の重なりがないことを検査し、末尾側から置換を適用する。
 */
export function applyPatches(body: string, edits: PatchEdit[]): string {
  const normalizedBody = body.replace(/\r\n/g, '\n');

  // 各 edit を元の本文に対して独立に検索
  const located: LocatedEdit[] = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const oldText = edit.oldText.replace(/\r\n/g, '\n');
    const newText = edit.newText.replace(/\r\n/g, '\n');

    const { first, count } = countOccurrences(normalizedBody, oldText);
    if (count === 0) {
      throw new NotePatchError({
        code: 'PATCH_NOT_FOUND',
        message: `置換対象の文字列が見つかりません (edits[${i}])`,
        editIndex: i,
      });
    }
    if (count > 1) {
      throw new NotePatchError({
        code: 'PATCH_AMBIGUOUS',
        message: `置換対象の文字列が複数箇所 (${count}箇所) 見つかりました (edits[${i}])`,
        editIndex: i,
        occurrences: count,
      });
    }

    located.push({
      index: i,
      start: first,
      end: first + oldText.length,
      oldText,
      newText,
    });
  }

  // 範囲の重なり検査
  for (let i = 0; i < located.length; i++) {
    for (let j = i + 1; j < located.length; j++) {
      const a = located[i];
      const b = located[j];
      if (Math.max(a.start, b.start) < Math.min(a.end, b.end)) {
        const minIdx = Math.min(a.index, b.index);
        const maxIdx = Math.max(a.index, b.index);
        throw new NotePatchError({
          code: 'PATCH_OVERLAP',
          message: `置換範囲が重複しています (edits[${minIdx}] と edits[${maxIdx}])`,
          editIndexes: [minIdx, maxIdx],
        });
      }
    }
  }

  // 末尾側から置換適用（インデックスずれ防止）
  const sorted = [...located].sort((a, b) => b.start - a.start);
  let result = normalizedBody;
  for (const loc of sorted) {
    result = result.slice(0, loc.start) + loc.newText + result.slice(loc.end);
  }

  return result;
}

// フロントマターブロック(開始〜終了フェンス)の抽出用(doc-service.ts と同一)
export const FM_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * 置換によってフロントマターが意図せず発生するのを防止する。
 * 元々フロントマターのないノートで、置換によって有効なフロントマターブロックが新たに形成された場合は拒否する。
 * (元々先頭が閉じのない --- や水平線であるノートで、末尾側のテキストを置換した場合は拒否しない)
 */
export function guardFrontmatter(
  originalBody: string,
  patchedBody: string,
  hasFrontmatter: boolean,
): string {
  if (!hasFrontmatter && FM_BLOCK_RE.test(patchedBody)) {
    throw new NotePatchError({
      code: 'PATCH_FRONTMATTER',
      message: '置換後の本文がフロントマター開始記号(---)で始まっているため拒否されました',
    });
  }
  return patchedBody;
}
