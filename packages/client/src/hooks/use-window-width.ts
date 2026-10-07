import { useEffect, useState } from 'react';

// #271: ウィンドウ幅の監視フック(描画時の右パネル幅 clamp・衝突判定用)
export function useWindowWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1280,
  );

  useEffect(() => {
    function handleResize() {
      setWidth(window.innerWidth);
    }

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return width;
}
