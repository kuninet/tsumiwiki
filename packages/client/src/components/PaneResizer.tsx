import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { useTabsStore, type PaneId, type SplitDir } from '../stores/tabs';

// Phase B2: 分割ペイン間のリサイザ。マウスドラッグで setPaneRatio を更新。
// dir='row'(左右分割)なら水平ドラッグ、dir='column'(上下分割)なら垂直ドラッグ。
//
// 実装メモ:
// - onMouseDown 時に親 split コンテナ([data-split-id])を closest で 1 回だけ引き当て
//   containerRef に保持する。mousemove ハンドラで document.querySelector を毎回
//   呼ぶのは 60Hz で無駄な上、ネスト split / iframe で id 衝突リスクもあった(Opus m4)
// - unmount 時のクリーンアップで body style も復旧する(ドラッグ途中で unmount された
//   場合の user-select/cursor 残留を防ぐ / Opus M1)

interface Props {
  splitId: PaneId;
  dir: SplitDir;
}

export function PaneResizer({ splitId, dir }: Props) {
  const setPaneRatio = useTabsStore((s) => s.setPaneRatio);
  const draggingRef = useRef(false);
  const containerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    function handleMove(e: MouseEvent) {
      if (!draggingRef.current) return;
      const container = containerRef.current;
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
      // ドラッグ中に unmount された場合の body style 残留を防ぐ(Opus M1)
      if (draggingRef.current) {
        draggingRef.current = false;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      }
    };
  }, [splitId, dir, setPaneRatio]);

  function handleMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    e.preventDefault();
    // 親 split コンテナを 1 回だけ引き当てる(Opus m4)
    containerRef.current = e.currentTarget.closest(`[data-split-id="${splitId}"]`);
    draggingRef.current = true;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = dir === 'row' ? 'col-resize' : 'row-resize';
  }

  return (
    <div
      data-testid={`resizer-${splitId}`}
      aria-label="ペイン境界"
      role="separator"
      aria-orientation={dir === 'row' ? 'vertical' : 'horizontal'}
      onMouseDown={handleMouseDown}
      className={
        dir === 'row'
          ? 'w-1 flex-shrink-0 cursor-col-resize bg-line hover:bg-accent-soft'
          : 'h-1 flex-shrink-0 cursor-row-resize bg-line hover:bg-accent-soft'
      }
    />
  );
}
