// unified diff文字列を行単位に分解し、表示用の種別を付与する純粋関数(設計04章4.3)
// add: 追加行(+) / del: 削除行(-) / hunk: @@ハンク見出し / meta: diff/index/+++/---等のヘッダ / context: その他

export type DiffLineType = 'add' | 'del' | 'context' | 'hunk' | 'meta';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export function parseDiff(diff: string): DiffLine[] {
  if (!diff) return [];

  const lines = diff.split('\n');
  // 文字列末尾の改行によりsplitで生じる空要素は表示上不要なので除く
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  // 種別は位置ベースで判定する: @@より前だけがヘッダ(meta)。
  // 接頭辞ベースの判定だと、frontmatter区切りや水平線「---」の削除行
  // (=「----」)がヘッダに誤分類される(#33レビュー指摘)
  let inHunk = false;
  return lines.map((line): DiffLine => {
    if (line.startsWith('@@')) {
      inHunk = true;
      return { type: 'hunk', text: line };
    }
    if (line.startsWith('diff ')) {
      // 複数ファイル差分の区切り(単一文書履歴では通常出ないが防御)
      inHunk = false;
      return { type: 'meta', text: line };
    }
    if (!inHunk) return { type: 'meta', text: line };
    if (line.startsWith('+')) return { type: 'add', text: line };
    if (line.startsWith('-')) return { type: 'del', text: line };
    return { type: 'context', text: line };
  });
}
