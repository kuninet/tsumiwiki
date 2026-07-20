import { type DragEvent as ReactDragEvent } from 'react';
import { useDragStore } from '../stores/drag';
import { useLayoutRoot, useTabsStore, type PaneId } from '../stores/tabs';

// Phase B2: タブドラッグ中に各ペインに重ねる 5 領域(左/右/上/下/中央)のドロップゾーン。
// 中央 = そのペインへ移動(タブ移動)
// 左右/上下 = そのペインを分割して片側に配置(新ペイン)
//
// 「最大 2 ペイン」制約(Epic #133 で合意)を UI 層で守るため、
// ルートが既に split の場合は 中央 のみ有効(L/R/T/B は非表示)にする。
// data-model 側の splitOrMove は N 分割まで受けるが、UI からは 1 分割までしか作らない

interface Props {
  paneId: PaneId;
}

type Position = 'left' | 'right' | 'top' | 'bottom' | 'center';

export function DropZoneOverlay({ paneId }: Props) {
  const draggingPath = useDragStore((s) => s.draggingPath);
  const sourcePaneId = useDragStore((s) => s.sourcePaneId);
  const endDrag = useDragStore((s) => s.end);
  const splitOrMove = useTabsStore((s) => s.splitOrMove);
  const root = useLayoutRoot();

  if (!draggingPath) return null;

  const isRootSplit = root.kind === 'split';

  // 同ペイン内 D&D は TabBar 側で reorder として扱うので overlay は出さない(誤発動防止)
  if (sourcePaneId === paneId) return null;

  function handleDrop(position: Position) {
    return (e: ReactDragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!draggingPath) return;
      splitOrMove(draggingPath, paneId, position);
      endDrag();
    };
  }

  function handleOver(e: ReactDragEvent) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }

  // 5 領域の配置(絶対配置)。「最大 2 ペイン」で既に split なら中央のみ
  return (
    <div
      data-testid={`dropzones-${paneId}`}
      className="pointer-events-none absolute inset-0 z-40"
      aria-hidden="true"
    >
      {!isRootSplit && (
        <>
          <div
            data-testid={`dropzone-${paneId}-left`}
            className="pointer-events-auto absolute left-0 top-0 h-full w-1/4 bg-accent/10 outline outline-2 outline-accent/40"
            onDragOver={handleOver}
            onDrop={handleDrop('left')}
          />
          <div
            data-testid={`dropzone-${paneId}-right`}
            className="pointer-events-auto absolute right-0 top-0 h-full w-1/4 bg-accent/10 outline outline-2 outline-accent/40"
            onDragOver={handleOver}
            onDrop={handleDrop('right')}
          />
          <div
            data-testid={`dropzone-${paneId}-top`}
            className="pointer-events-auto absolute left-1/4 top-0 h-1/4 w-1/2 bg-accent/10 outline outline-2 outline-accent/40"
            onDragOver={handleOver}
            onDrop={handleDrop('top')}
          />
          <div
            data-testid={`dropzone-${paneId}-bottom`}
            className="pointer-events-auto absolute bottom-0 left-1/4 h-1/4 w-1/2 bg-accent/10 outline outline-2 outline-accent/40"
            onDragOver={handleOver}
            onDrop={handleDrop('bottom')}
          />
        </>
      )}
      <div
        data-testid={`dropzone-${paneId}-center`}
        className={
          isRootSplit
            ? 'pointer-events-auto absolute inset-0 bg-accent/10 outline outline-2 outline-accent/40'
            : 'pointer-events-auto absolute left-1/4 top-1/4 h-1/2 w-1/2 bg-accent/20 outline outline-2 outline-accent/60'
        }
        onDragOver={handleOver}
        onDrop={handleDrop('center')}
      />
    </div>
  );
}
