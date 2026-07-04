import { useEffect } from 'react';

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

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
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
      role="menu"
      style={{ left: x, top: y }}
      className="fixed z-50 min-w-[160px] rounded border border-gray-200 bg-white py-1 text-sm shadow-lg"
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
          className={`block w-full px-3 py-1.5 text-left hover:bg-gray-100 ${
            item.danger ? 'text-red-600' : 'text-gray-700'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
