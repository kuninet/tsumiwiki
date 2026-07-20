import { useMediaQuery } from '../hooks/use-media-query';
import { type PaneNode } from '../stores/tabs';
import { PaneResizer } from './PaneResizer';
import { PaneView } from './PaneView';

// Phase B2: レイアウトツリーの再帰レンダラ。
// - leaf → PaneView
// - split → dir に応じて flex-row / flex-col に並べ、間に PaneResizer

interface Props {
  node: PaneNode;
}

export function PaneLayout({ node }: Props) {
  // Phase D(#139): モバイル(狭幅)では分割 UI を縦積み・50/50 に潰し、resizer を隠す。
  // 分割ペインを 2 つ並べる幅がない前提。データ構造(root)自体は変更しない
  const isMobile = useMediaQuery('(max-width: 767px)');

  if (node.kind === 'leaf') {
    return <PaneView pane={node} />;
  }
  const isRow = !isMobile && node.dir === 'row';
  const ratio = isMobile ? 0.5 : Math.max(0.1, Math.min(0.9, node.ratio));
  const aStyle = isRow
    ? { flex: `0 0 calc(${ratio * 100}% - 2px)`, minWidth: 0 }
    : { flex: `0 0 calc(${ratio * 100}% - 2px)`, minHeight: 0 };
  return (
    <div
      data-split-id={node.id}
      data-testid={`split-${node.id}`}
      data-mobile={isMobile}
      className={`flex h-full min-h-0 min-w-0 ${isRow ? 'flex-row' : 'flex-col'}`}
    >
      <div style={aStyle} className="min-h-0 min-w-0 overflow-hidden">
        <PaneLayout node={node.a} />
      </div>
      {!isMobile && <PaneResizer splitId={node.id} dir={node.dir} />}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <PaneLayout node={node.b} />
      </div>
    </div>
  );
}
