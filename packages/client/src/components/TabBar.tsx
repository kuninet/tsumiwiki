import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { docUrl, titleFromPath } from '../lib/doc-path';
import { useDragStore } from '../stores/drag';
import {
  getActivePaneActiveIdFromState,
  getActivePaneTabsFromState,
  useTabsStore,
  type LeafPane,
  type PaneId,
} from '../stores/tabs';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

// 編集/閲覧ペインのタブバー(Epic #133 / Phase A-1 + A-2 + B2)。
// - preview タブは斜体で表示 / dirty タブは先頭に「●」
// - タブクリックでアクティブ切替 + そのペインを activePane に(URL は /doc/* へ追随)
// - ダブルクリックで preview → pinned に昇格
// - 「×」/ middle-click / Ctrl+W(⌘W)で閉じる。dirty は CloseConfirmDialog を経由
// - 右クリックで「ピン留め/解除・他/右/全て閉じる」メニュー
// - HTML5 D&D: 同ペイン内は並べ替え、別ペインへは splitOrMove(DropZoneOverlay 側で受ける)
//
// Phase B2 でペイン単位化: paneId を省略すると活性ペイン相当(単一ペイン運用の後方互換)、
// 明示すると当該ペインのタブを描画する

interface CtxMenuState {
  x: number;
  y: number;
  path: string;
}

interface Props {
  paneId?: PaneId;
}

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

export function TabBar({ paneId }: Props = {}) {
  // paneId が渡された場合はそのペイン、なければ活性ペインを対象にする
  const pane = useTabsStore((s) => {
    const targetId = paneId ?? s.activePaneId;
    return findLeafShallow(s.root, targetId);
  });
  const isActivePane = useTabsStore((s) => (paneId ?? s.activePaneId) === s.activePaneId);
  const tabs = pane?.tabs ?? EMPTY_TABS;
  const activeId = pane?.activeId ?? null;

  const setActive = useTabsStore((s) => s.setActive);
  const setActivePane = useTabsStore((s) => s.setActivePane);
  const promoteToPinned = useTabsStore((s) => s.promoteToPinned);
  const unpin = useTabsStore((s) => s.unpin);
  const closeTab = useTabsStore((s) => s.closeTab);
  const closeOthers = useTabsStore((s) => s.closeOthers);
  const closeToRight = useTabsStore((s) => s.closeToRight);
  const closeAll = useTabsStore((s) => s.closeAll);
  const requestClose = useTabsStore((s) => s.requestClose);
  const reorder = useTabsStore((s) => s.reorder);
  const startDrag = useDragStore((s) => s.start);
  const endDrag = useDragStore((s) => s.end);
  const navigate = useNavigate();
  const location = useLocation();
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  function activateAndNavigate(path: string) {
    // クリックされたペインを activePane にしてから該当タブへ切替。
    // setActive(path) 内でも activePaneId を該当ペインに合わせるので冗長だが、
    // paneId が省略のときは setActive のみでよい
    if (paneId) setActivePane(paneId);
    setActive(path);
    if (window.location.pathname !== docUrl(path)) navigate(docUrl(path));
  }

  function navigateToActive() {
    const nextActive = getActivePaneActiveIdFromState(useTabsStore.getState());
    if (!nextActive) {
      if (locationRef.current.pathname !== '/') navigate('/');
      return;
    }
    const desired = docUrl(nextActive);
    if (locationRef.current.pathname !== desired) navigate(desired);
  }

  function closeAndFollow(path: string) {
    closeTab(path);
    navigateToActive();
  }

  function requestOrClose(path: string) {
    const target = tabs.find((t) => t.path === path);
    if (!target) return;
    if (target.dirty) {
      activateAndNavigate(path);
      requestClose(path);
    } else {
      closeAndFollow(path);
    }
  }

  const locationRef = useRef(location);
  locationRef.current = location;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Ctrl+W(⌘W): 活性ペインのアクティブタブを閉じる。paneId 引数を持たない global listener
  // なので常に「活性ペインの activeId」を参照する(ペインが分かれていても意図通り)
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.isComposing) return;
      const activePath = getActivePaneActiveIdFromState(useTabsStore.getState());
      if (!activePath) return;
      const modOk = isMac() ? e.metaKey : e.ctrlKey;
      if (!(modOk && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w')) return;
      e.preventDefault();
      const activePaneTabs = getActivePaneTabsFromState(useTabsStore.getState());
      const target = activePaneTabs.find((t) => t.path === activePath);
      if (!target) return;
      if (target.dirty) {
        useTabsStore.getState().requestClose(activePath);
      } else {
        useTabsStore.getState().closeTab(activePath);
        const nextActive = getActivePaneActiveIdFromState(useTabsStore.getState());
        const desired = nextActive ? docUrl(nextActive) : '/';
        if (window.location.pathname !== desired) navigateRef.current(desired);
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  if (tabs.length === 0) return null;

  function buildMenuItems(path: string): ContextMenuItem[] {
    const tab = tabs.find((t) => t.path === path);
    const others = tabs.filter((t) => t.path !== path);
    const idx = tabs.findIndex((t) => t.path === path);
    const hasRight = idx >= 0 && idx < tabs.length - 1;
    return [
      tab?.kind === 'pinned'
        ? { label: 'ピン留め解除', onSelect: () => unpin(path) }
        : { label: 'ピン留め', onSelect: () => promoteToPinned(path) },
      {
        label: '閉じる',
        onSelect: () => requestOrClose(path),
        danger: tab?.dirty,
      },
      ...(others.length > 0
        ? [
            {
              label: '他をすべて閉じる',
              onSelect: () => {
                closeOthers(path);
                navigateToActive();
              },
            },
          ]
        : []),
      ...(hasRight
        ? [
            {
              label: '右側をすべて閉じる',
              onSelect: () => {
                closeToRight(path);
                navigateToActive();
              },
            },
          ]
        : []),
      {
        label: 'すべて閉じる',
        onSelect: () => {
          closeAll();
          navigateToActive();
        },
        danger: true,
      },
    ];
  }

  function handleTabMouseDown(e: ReactMouseEvent, path: string) {
    if (e.button === 1) {
      e.preventDefault();
      requestOrClose(path);
    }
  }

  // ---- HTML5 D&D ----
  function handleDragStart(e: ReactDragEvent, index: number, path: string) {
    setDragIndex(index);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', path);
    }
    // ペイン外 D&D を判定できるように、ドラッグ中の path と source pane を共有ストアに
    if (pane) startDrag(path, pane.id);
  }
  function handleDragOver(e: ReactDragEvent) {
    if (dragIndex === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }
  function handleDrop(e: ReactDragEvent, toIndex: number) {
    e.preventDefault();
    if (dragIndex === null) return;
    const dragged = tabs[dragIndex];
    if (dragged) reorder(dragged.path, toIndex);
    setDragIndex(null);
    endDrag();
  }
  function handleDragEnd() {
    setDragIndex(null);
    endDrag();
  }

  const tabbarActiveClass = isActivePane ? '' : 'opacity-90';

  return (
    <>
      <div
        role="tablist"
        aria-label="文書タブ"
        data-testid={paneId ? `tabbar-${paneId}` : 'tabbar'}
        className={`flex flex-shrink-0 items-stretch overflow-x-auto border-b border-line bg-panel ${tabbarActiveClass}`}
        onMouseDown={() => {
          // ペイン内をクリックしたらそのペインを activePane にする(TabBar のクリックでも同様)
          if (paneId && paneId !== useTabsStore.getState().activePaneId) setActivePane(paneId);
        }}
      >
        {tabs.map((tab, index) => {
          const isTabActive = tab.path === activeId;
          const italic = tab.kind === 'preview' ? 'italic' : '';
          const activeCls = isTabActive
            ? 'bg-canvas text-ink border-b-2 border-accent'
            : 'text-ink-soft border-b-2 border-transparent hover:bg-hoverbg';
          return (
            <div
              key={tab.path}
              role="tab"
              aria-selected={isTabActive}
              data-testid={`tab-${tab.path}`}
              title={tab.path}
              draggable
              onDragStart={(e) => handleDragStart(e, index, tab.path)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              onClick={() => activateAndNavigate(tab.path)}
              onDoubleClick={() => {
                if (tab.kind === 'preview') promoteToPinned(tab.path);
              }}
              onMouseDown={(e) => handleTabMouseDown(e, tab.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu({ x: e.clientX, y: e.clientY, path: tab.path });
              }}
              className={`flex min-w-0 max-w-[220px] cursor-pointer select-none items-center gap-1 px-3 py-1.5 text-sm ${italic} ${activeCls}`}
            >
              {tab.dirty && (
                <span aria-hidden="true" className="flex-shrink-0 text-accent">
                  ●
                </span>
              )}
              <span className="truncate">{titleFromPath(tab.path)}</span>
              <button
                type="button"
                aria-label="タブを閉じる"
                data-testid={`tab-close-${tab.path}`}
                onClick={(e) => {
                  e.stopPropagation();
                  requestOrClose(tab.path);
                }}
                className="ml-1 rounded px-1 text-ink-faint hover:bg-active hover:text-ink"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildMenuItems(ctxMenu.path)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </>
  );
}

// TabBar 内で使う小道具。store 内部の findLeafById と等価だが hook のセレクタ最適化のため
// TabBar 側でシャロー参照する。パニックを避けて undefined を返す
function findLeafShallow(node: import('../stores/tabs').PaneNode, id: PaneId): LeafPane | null {
  if (node.kind === 'leaf') return node.id === id ? node : null;
  return findLeafShallow(node.a, id) ?? findLeafShallow(node.b, id);
}

// 空配列参照の共用(useActivePaneTabs と同趣旨)
const EMPTY_TABS: never[] = Object.freeze([]) as unknown as never[];
