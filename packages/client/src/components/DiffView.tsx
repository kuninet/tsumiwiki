import type { DiffLine } from '../lib/parse-diff';
import { renderDiffInline } from '../lib/render-diff-inline';

// 履歴パネル『差分』タブの表示コンポーネント(#64)。
// git出力の生表示 (@@ハンク・+/-プレフィクス・font-mono) をやめ、本文に混ざった
// 見た目に近づける。行種別は背景色で示し、削除行は打ち消し線で表す。ハンクの境目は
// 細い区切り線として描画し、---/+++/diff などのメタ情報は非表示にする。

// 表示グループ(連続する同種行を1ブロックにまとめる):
// - context / add / del を集約 → 変わり目で新しいブロック
// - hunk を境界としてブロックをリセット(区切り線 <hr>)
// - meta は捨てる
type DisplayGroup =
  | { kind: 'add' | 'del' | 'context'; texts: string[] }
  | { kind: 'divider' };

function stripPrefix(type: DiffLine['type'], text: string): string {
  if (type === 'add' || type === 'del') return text.slice(1);
  if (type === 'context') return text.startsWith(' ') ? text.slice(1) : text;
  return text;
}

// 差分行を表示グループへ整形する。ハンクの境界は最初の1回だけ dividerを差し込む
// (先頭にハンクがある場合は divider を出さない — 上に何もないのに区切り線が浮くのを防ぐ)
export function groupDiffLines(lines: DiffLine[]): DisplayGroup[] {
  const groups: DisplayGroup[] = [];
  let sawContentSinceDivider = false;

  function push(kind: 'add' | 'del' | 'context', text: string) {
    const last = groups[groups.length - 1];
    if (last && 'kind' in last && last.kind === kind && Array.isArray((last as { texts: string[] }).texts)) {
      (last as { texts: string[] }).texts.push(text);
    } else {
      groups.push({ kind, texts: [text] });
    }
    sawContentSinceDivider = true;
  }

  for (const line of lines) {
    if (line.type === 'meta') continue;
    if (line.type === 'hunk') {
      if (sawContentSinceDivider) {
        groups.push({ kind: 'divider' });
        sawContentSinceDivider = false;
      }
      continue;
    }
    push(line.type, stripPrefix(line.type, line.text));
  }
  return groups;
}

const KIND_CLASS: Record<'add' | 'del' | 'context', string> = {
  // 追加: 薄緑背景、border-l に success 色でグルーピングを示す
  add: 'bg-success/10 border-l-2 border-success/60 pl-2 -mx-1 my-0.5',
  // 削除: 薄赤背景 + 打ち消し線
  del: 'bg-danger/[0.08] border-l-2 border-danger/60 pl-2 -mx-1 my-0.5 line-through opacity-80',
  context: '',
};

interface DiffViewProps {
  lines: DiffLine[];
}

export function DiffView({ lines }: DiffViewProps) {
  const groups = groupDiffLines(lines);

  if (groups.length === 0) {
    return <p className="text-sm text-ink-faint">変更はありません</p>;
  }

  return (
    <div className="text-sm text-ink-soft leading-relaxed">
      {groups.map((g, i) => {
        if (g.kind === 'divider') {
          return <hr key={i} className="my-3 border-t border-line" />;
        }
        return (
          <div key={i} className={KIND_CLASS[g.kind]}>
            {g.texts.map((t, j) => (
              // 各行はエスケープ後にinlineのmarkdown装飾だけ復元する。空行は改行分の高さを確保。
              <div
                key={j}
                className="whitespace-pre-wrap break-words"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: 出力はrenderDiffInlineで
                // HTMLエスケープ済み+許可されたspanのみを組み立てているため、XSSの経路は塞がれている
                dangerouslySetInnerHTML={{ __html: renderDiffInline(t) || '&nbsp;' }}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
