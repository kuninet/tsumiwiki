// unified diff文字列を行単位に分解し、表示用の種別を付与する純粋関数(設計04章4.3)
// add: 追加行(+) / del: 削除行(-) / hunk: @@ハンク見出し / meta: diff/index/+++/---等のヘッダ / context: その他

export type DiffLineType = 'add' | 'del' | 'context' | 'hunk' | 'meta';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

function isMetaLine(line: string): boolean {
  return (
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('diff ') ||
    line.startsWith('index ')
  );
}

export function parseDiff(diff: string): DiffLine[] {
  if (!diff) return [];

  const lines = diff.split('\n');
  // 文字列末尾の改行によりsplitで生じる空要素は表示上不要なので除く
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.map((line): DiffLine => {
    if (isMetaLine(line)) return { type: 'meta', text: line };
    if (line.startsWith('@@')) return { type: 'hunk', text: line };
    if (line.startsWith('+')) return { type: 'add', text: line };
    if (line.startsWith('-')) return { type: 'del', text: line };
    return { type: 'context', text: line };
  });
}
