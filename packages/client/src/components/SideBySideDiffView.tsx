import type { DocSummary } from '@tsumiwiki/shared';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { handleWikilinkClick } from '../lib/handle-wikilink-click';
import type { DiffLine } from '../lib/parse-diff';
import { renderDiffInline } from '../lib/render-diff-inline';
import { useToastStore } from '../stores/toast';

// 履歴全画面ページの「2列」レイアウト用差分表示(#66 Phase 1c)。
// DiffView(1列)とは別コンポーネントとして新規追加し、既存DiffViewには手を入れない。
// 左に旧版(del + context)・右に新版(add + context)を並べ、対応するadd/delペアを
// 同じ行に揃えて表示する。renderDiffInline・handleWikilinkClickはDiffViewと共用する。

type CellKind = 'add' | 'del' | 'context';

interface Cell {
  kind: CellKind;
  text: string;
}

interface Row {
  left?: Cell;
  right?: Cell;
  divider?: boolean;
}

// diff行をhunk単位に処理し、連続するdel/addを同じインデックスで左右に対応付ける。
// contextに到達したら溜まっているdel/addペアを吐き出してから、context行は左右両方に置く。
// ハンク境界では直前に内容があった場合のみdividerを1回差し込む(先頭ハンクでは出さない)。
export function buildRows(lines: DiffLine[]): Row[] {
  const rows: Row[] = [];
  let dels: string[] = [];
  let adds: string[] = [];
  let sawContentSinceDivider = false;

  function flushPending() {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      rows.push({
        left: i < dels.length ? { kind: 'del', text: dels[i] } : undefined,
        right: i < adds.length ? { kind: 'add', text: adds[i] } : undefined,
      });
    }
    dels = [];
    adds = [];
    if (n > 0) sawContentSinceDivider = true;
  }

  for (const line of lines) {
    if (line.type === 'meta') continue;
    if (line.type === 'hunk') {
      flushPending();
      if (sawContentSinceDivider) {
        rows.push({ divider: true });
        sawContentSinceDivider = false;
      }
      continue;
    }
    if (line.type === 'del') {
      dels.push(line.text.slice(1));
      continue;
    }
    if (line.type === 'add') {
      adds.push(line.text.slice(1));
      continue;
    }
    flushPending();
    const text = line.text.startsWith(' ') ? line.text.slice(1) : line.text;
    rows.push({ left: { kind: 'context', text }, right: { kind: 'context', text } });
    sawContentSinceDivider = true;
  }
  flushPending();
  return rows;
}

const CELL_CLASS: Record<CellKind, string> = {
  add: 'bg-success/10 border-l-2 border-success/60 pl-2',
  del: 'bg-danger/[0.08] border-l-2 border-danger/60 pl-2 line-through opacity-80',
  context: '',
};

const EMPTY_CELL_CLASS = 'bg-panel-2/30';

function DiffCell({ cell }: { cell?: Cell }) {
  if (!cell) {
    return <div className={`${EMPTY_CELL_CLASS} whitespace-pre-wrap break-words`}>&nbsp;</div>;
  }
  return (
    <div
      className={`${CELL_CLASS[cell.kind]} whitespace-pre-wrap break-words`}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: 出力はrenderDiffInlineで
      // HTMLエスケープ済み+許可されたspanのみを組み立てているため、XSSの経路は塞がれている
      dangerouslySetInnerHTML={{ __html: renderDiffInline(cell.text) || '&nbsp;' }}
    />
  );
}

function DiffRow({ row }: { row: Row }) {
  return (
    <>
      <DiffCell cell={row.left} />
      <DiffCell cell={row.right} />
    </>
  );
}

interface SideBySideDiffViewProps {
  lines: DiffLine[];
  // DiffViewと同じく、差分内wikilinkのクリックナビゲーションに使う(#96)
  docs: DocSummary[];
}

export function SideBySideDiffView({ lines, docs }: SideBySideDiffViewProps) {
  const rows = buildRows(lines);
  const navigate = useNavigate();
  const showToast = useToastStore((s) => s.show);

  function handleClick(e: ReactMouseEvent<HTMLDivElement>) {
    handleWikilinkClick(e.target, docs, navigate, showToast);
  }

  if (rows.length === 0) {
    return <p className="text-sm text-ink-faint">変更はありません</p>;
  }

  return (
    <div
      data-testid="side-by-side-diff-view"
      className="grid grid-cols-2 gap-2 text-sm text-ink-soft leading-relaxed"
      onClick={handleClick}
    >
      {rows.map((row, i) =>
        row.divider ? (
          <hr key={i} className="col-span-2 my-3 border-t border-line" />
        ) : (
          <DiffRow key={i} row={row} />
        ),
      )}
    </div>
  );
}
