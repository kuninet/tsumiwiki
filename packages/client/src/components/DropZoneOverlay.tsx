import { type DragEvent as ReactDragEvent, useRef, useState } from 'react';
import { useMediaQuery } from '../hooks/use-media-query';
import { useDragStore } from '../stores/drag';
import { useLayoutRoot, useTabsStore, type PaneId } from '../stores/tabs';

// Phase B2 / D: タブドラッグ中に各ペインへ重ねるドロップゾーン。VSCode 風に
// 「今のマウス位置に対応する 1 領域だけ」ハイライトする(動的プレビュー)。
//
// 領域の判定:
// - ペイン矩形を relative x, y に正規化(0-1)
// - 端に近い方の距離を見て、その端(L/R/T/B)を選ぶ
// - 中央から近ければ 'center'
// - 端 vs 中央のしきい値は 25%(4 分割時の 1 スロット幅と揃える)
//
// 制約:
// - ルートが既に split(=最大 2 ペイン)なら L/R/T/B は無効、center のみ
// - source pane 上では center を無効(同ペイン内の reorder は TabBar が担当)
// - モバイルでは分割 UI 自体を無効

interface Props {
  paneId: PaneId;
}

type Position = 'left' | 'right' | 'top' | 'bottom' | 'center';

// 座標分類はテストしやすいよう pure 関数として export する。
// jsdom は DragEvent の clientX/Y を安定に運ばないので、ここを直接 unit test する
export function classifyPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  allowSides: boolean,
  allowCenter: boolean,
): Position | null {
  if (width <= 0 || height <= 0) return null;
  const nx = x / width;
  const ny = y / height;
  if (allowSides) {
    // 各端との距離
    const dLeft = nx;
    const dRight = 1 - nx;
    const dTop = ny;
    const dBottom = 1 - ny;
    const minEdge = Math.min(dLeft, dRight, dTop, dBottom);
    // 端に「近い」= しきい値 0.25 未満
    if (minEdge < 0.25) {
      if (minEdge === dLeft) return 'left';
      if (minEdge === dRight) return 'right';
      if (minEdge === dTop) return 'top';
      if (minEdge === dBottom) return 'bottom';
    }
  }
  return allowCenter ? 'center' : null;
}

function regionStyle(pos: Position): React.CSSProperties {
  switch (pos) {
    case 'left':
      return { left: 0, top: 0, width: '50%', height: '100%' };
    case 'right':
      return { right: 0, top: 0, width: '50%', height: '100%' };
    case 'top':
      return { left: 0, top: 0, width: '100%', height: '50%' };
    case 'bottom':
      return { left: 0, bottom: 0, width: '100%', height: '50%' };
    case 'center':
      return { inset: 0 };
  }
}

export function DropZoneOverlay({ paneId }: Props) {
  const draggingPath = useDragStore((s) => s.draggingPath);
  const sourcePaneId = useDragStore((s) => s.sourcePaneId);
  const endDrag = useDragStore((s) => s.end);
  const splitOrMove = useTabsStore((s) => s.splitOrMove);
  const root = useLayoutRoot();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [currentPos, setCurrentPos] = useState<Position | null>(null);

  if (isMobile) return null;
  if (!draggingPath) return null;

  const isRootSplit = root.kind === 'split';
  const isSourcePane = sourcePaneId === paneId;
  const allowSides = !isRootSplit;
  // source ペイン上で center はカバーしない(reorder は TabBar が担う)
  const allowCenter = !isSourcePane;

  // ドラッグ元と対象が同ペインで、split もできない設定なら何もハイライトしない
  if (!allowSides && !allowCenter) return null;

  function handleDragOver(e: ReactDragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pos = classifyPosition(
      e.clientX - rect.left,
      e.clientY - rect.top,
      rect.width,
      rect.height,
      allowSides,
      allowCenter,
    );
    if (pos !== currentPos) setCurrentPos(pos);
  }

  function handleDragLeave(e: ReactDragEvent<HTMLDivElement>) {
    // 子要素(preview 側)へ入っただけの leave は無視
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (currentPos !== null) setCurrentPos(null);
  }

  function handleDrop(e: ReactDragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (!draggingPath || !currentPos) {
      endDrag();
      setCurrentPos(null);
      return;
    }
    splitOrMove(draggingPath, paneId, currentPos);
    endDrag();
    setCurrentPos(null);
  }

  return (
    <div
      ref={containerRef}
      data-testid={`dropzones-${paneId}`}
      className="absolute inset-0 z-40"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {currentPos && (
        <div
          data-testid={`dropzone-${paneId}-${currentPos}`}
          aria-hidden="true"
          className="pointer-events-none absolute rounded border-2 border-dashed border-accent bg-accent/20 transition-all duration-100"
          style={regionStyle(currentPos)}
        />
      )}
    </div>
  );
}
