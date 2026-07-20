import { useEffect, useRef } from 'react';
import { useTabsStore, type PaneId, type SplitDir } from '../stores/tabs';

// Phase B2: 分割ペイン間のリサイザ。マウスドラッグで setPaneRatio を更新。
// dir='row'(左右分割)なら水平ドラッグ、dir='column'(上下分割)なら垂直ドラッグ。
// 実際の分割コンテナ(親)の getBoundingClientRect を測って mouse 位置から比率を出す。

interface Props {
  splitId: PaneId;
  dir: SplitDir;
}

export function PaneResizer({ splitId, dir }: Props) {
  const setPaneRatio = useTabsStore((s) => s.setPaneRatio);
  const draggingRef = useRef(false);

  useEffect(() => {
    function handleMove(e: MouseEvent) {
      if (!draggingRef.current) return;
      // 親ノード(split コンテナ)の rect を辿って計算する
      const container = document.querySelector<HTMLElement>(`[data-split-id="${splitId}"]`);
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const ratio =
        dir === 'row'
          ? (e.clientX - rect.left) / rect.width
          : (e.clientY - rect.top) / rect.height;
      setPaneRatio(splitId, ratio);
    }
    function handleUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [splitId, dir, setPaneRatio]);

  return (
    <div
      data-testid={`resizer-${splitId}`}
      aria-label="ペイン境界"
      role="separator"
      aria-orientation={dir === 'row' ? 'vertical' : 'horizontal'}
      onMouseDown={(e) => {
        e.preventDefault();
        draggingRef.current = true;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = dir === 'row' ? 'col-resize' : 'row-resize';
      }}
      className={
        dir === 'row'
          ? 'w-1 flex-shrink-0 cursor-col-resize bg-line hover:bg-accent-soft'
          : 'h-1 flex-shrink-0 cursor-row-resize bg-line hover:bg-accent-soft'
      }
    />
  );
}
