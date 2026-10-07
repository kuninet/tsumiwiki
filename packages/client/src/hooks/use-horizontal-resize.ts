import { useCallback, useEffect, useRef } from 'react';

// #271: 左右ペイン/サイドバーの幅ドラッグリサイズ用共通フック
export interface UseHorizontalResizeOptions {
  side: 'left' | 'right';
  onResize: (rawWidth: number) => void;
}

export interface UseHorizontalResizeResult {
  onMouseDown: (e: React.MouseEvent) => void;
}

export function useHorizontalResize({
  side,
  onResize,
}: UseHorizontalResizeOptions): UseHorizontalResizeResult {
  const draggingRef = useRef(false);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const sideRef = useRef(side);
  sideRef.current = side;

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, []);

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!draggingRef.current) return;
      const rawWidth =
        sideRef.current === 'left' ? e.clientX : window.innerWidth - e.clientX;
      onResizeRef.current(rawWidth);
    }

    function handleMouseUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (draggingRef.current) {
        draggingRef.current = false;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      }
    };
  }, []);

  return { onMouseDown };
}
