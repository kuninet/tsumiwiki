import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// フォルダツリー等で使う汎用の右クリックコンテキストメニュー(設計04章4.2)

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const VIEWPORT_MARGIN = 4;

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  // 実際の描画サイズを測ってから、右端・下端でビューポート外へはみ出さないよう補正する
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) {
      setPosition({ x, y });
      return;
    }
    const rect = el.getBoundingClientRect();
    const clampedX = Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - rect.width - VIEWPORT_MARGIN));
    const clampedY = Math.max(VIEWPORT_MARGIN, Math.min(y, window.innerHeight - rect.height - VIEWPORT_MARGIN));
    setPosition({ x: clampedX, y: clampedY });
  }, [x, y]);

  useEffect(() => {
    window.addEventListener('click', onClose);
    window.addEventListener('contextmenu', onClose);
    return () => {
      window.removeEventListener('click', onClose);
      window.removeEventListener('contextmenu', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      style={{ left: position.x, top: position.y }}
      className="fixed z-[50] min-w-[160px] rounded border border-line bg-panel py-1 text-sm text-ink shadow-lg"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            item.onSelect();
            onClose();
          }}
          className={`block w-full px-3 py-1.5 text-left hover:bg-hoverbg ${
            item.danger ? 'text-danger' : 'text-ink-soft'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
