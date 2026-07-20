import { type DragEvent as ReactDragEvent, useRef, useState } from 'react';
import { useMediaQuery } from '../hooks/use-media-query';
import { useDragStore } from '../stores/drag';
import { useLeafCount, useTabsStore, type PaneId } from '../stores/tabs';

// Phase B2 / D / #147: タブドラッグ中に各ペインへ重ねるドロップゾーン。
// VSCode 風の「今のマウス位置に対応する 1 領域だけ」を動的にハイライトする。
//
// 領域の判定:
// - ペイン矩形を relative x, y に正規化(0-1)
// - 端に「近い」と判定するしきい値は 25%
// - しきい値未満の端(L/R/T/B)を選ぶ
// - 中央付近は 'center'
//
// 制約:
// - 各 leaf ペインで自由に分割可能(#147 で N 分割対応)
// - 「大量分割で画面が破綻する」ことを防ぐため、leaf 総数が MAX_PANES に達すると
//   L/R/T/B は無効化して center(移動)のみ許容する
// - source pane 上では center を無効(同ペイン内の reorder は TabBar が担当)
// - モバイルでは分割 UI 自体を無効

// 分割の上限。緩めのキャップ。もっと欲しくなったら緩める(モバイル時のスクロール
// 縮退などの副作用は要注意 → issue で追跡)
export const MAX_PANES = 4;

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
    const dLeft = nx;
    const dRight = 1 - nx;
    const dTop = ny;
    const dBottom = 1 - ny;
    const minEdge = Math.min(dLeft, dRight, dTop, dBottom);
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
  const leafCount = useLeafCount();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [currentPos, setCurrentPos] = useState<Position | null>(null);

  if (isMobile) return null;
  if (!draggingPath) return null;

  const isSourcePane = sourcePaneId === paneId;
  // 分割の可否は「現ペイン数 < MAX_PANES」で判定。上限に達したら L/R/T/B を出さず
  // center(=移動)のみに縮退。#147 以前は root が split の時点で L/R/T/B を封じていたが、
  // N 分割対応で「任意の leaf を再分割してよい」に変更された
  const allowSides = leafCount < MAX_PANES;
  const allowCenter = !isSourcePane;

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
      data-allow-sides={allowSides}
      data-allow-center={allowCenter}
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

