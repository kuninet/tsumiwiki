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

// 今開いているメニューの閉じる関数(開けるメニューは1つ)
let openMenuClose: (() => void) | null = null;

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

  // 呼び出し元は onClose を毎レンダー作り直すので、最新の関数を ref で持つ
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 開けるメニューは常に1つ(#301)。新しく開いたら、ほかのメニューを閉じる。
  // 開く側が stopPropagation していても(FolderTree の行・DocView の表など)閉じられるよう、
  // イベントの伝播に頼らずモジュール単位で「今開いているメニュー」を持つ
  useEffect(() => {
    const close = () => onCloseRef.current();
    if (openMenuClose && openMenuClose !== close) openMenuClose();
    openMenuClose = close;
    return () => {
      if (openMenuClose === close) openMenuClose = null;
    };
  }, []);

  useEffect(() => {
    const handleClick = () => onCloseRef.current();
    // 右クリックは window の capture で受ける(#301)。
    // - メニューを開いた右クリックそのものでは閉じない: このリスナは開いた後に登録されるので、
    //   そのイベントの window の capture はもう過ぎている(bubble で受けると、React の
    //   描画と effect がリスナの間に走り、同じイベントが window に届いて即閉じしていた)
    // - 別の場所の右クリックは、そこで stopPropagation されても capture なので必ず届く。
    //   同じコンポーネントが別の対象でメニューを開き直すときも、閉じてから開く順になる
    const handleContextMenu = (e: MouseEvent) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      onCloseRef.current();
    };
    window.addEventListener('click', handleClick);
    window.addEventListener('contextmenu', handleContextMenu, true);
    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('contextmenu', handleContextMenu, true);
    };
  }, []);

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
