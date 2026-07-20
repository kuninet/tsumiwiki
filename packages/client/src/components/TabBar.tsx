import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { docUrl, titleFromPath } from '../lib/doc-path';
import {
  getActivePaneActiveIdFromState,
  getActivePaneTabsFromState,
  useActivePaneActiveId,
  useActivePaneTabs,
  useTabsStore,
} from '../stores/tabs';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

// 編集/閲覧ペインのタブバー(Epic #133 / Phase A-1 + A-2)。
// - preview タブは斜体で表示
// - dirty タブは先頭に「●」を付与
// - タブクリックでアクティブ切替。URL は同時に /doc/* へ追随させる
// - タブをダブルクリックで pinned に昇格(preview の場合)
// - 「×」ボタン・middle-click(button===1)・Ctrl+W(⌘W)で閉じる。dirty のときは
//   CloseConfirmDialog(MainPage 常駐)で保存/破棄/キャンセルを確認する
// - 右クリックで「ピン留め/解除・他/右/全て閉じる」メニュー
// - ネイティブ HTML5 D&D で同ペイン内タブを並べ替え(dnd-kit 依存を避けて軽く実装)

interface CtxMenuState {
  x: number;
  y: number;
  path: string;
}

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

export function TabBar() {
  // Phase B: 単一ペインの UI は変えない。木構造から activePane の tabs/activeId を取り出して使う
  const tabs = useActivePaneTabs();
  const activeId = useActivePaneActiveId();
  const setActive = useTabsStore((s) => s.setActive);
  const promoteToPinned = useTabsStore((s) => s.promoteToPinned);
  const unpin = useTabsStore((s) => s.unpin);
  const closeTab = useTabsStore((s) => s.closeTab);
  const closeOthers = useTabsStore((s) => s.closeOthers);
  const closeToRight = useTabsStore((s) => s.closeToRight);
  const closeAll = useTabsStore((s) => s.closeAll);
  const requestClose = useTabsStore((s) => s.requestClose);
  const reorder = useTabsStore((s) => s.reorder);
  const navigate = useNavigate();
  const location = useLocation();
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  function activateAndNavigate(path: string) {
    if (activeId === path) return;
    setActive(path);
    navigate(docUrl(path));
  }

  // 閉じ操作後に「新しい activeId の URL」に navigate する。
  // 「activeId が消えたら / に戻す」を含む。この関数を close 系操作の直後に必ず呼ぶ
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

  // dirty なら確認ダイアログ、そうでなければ即閉じる。dirty タブが背景にあった場合は
  // ダイアログを見せるためにまずアクティブへ移動する
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

  // 「activeId → URL 追随」の useEffect は意図的に持たない。
  //
  // 過去実装(あった時):useEffect(activeId, tabs.length, location.pathname) で
  // activeId 変化を検知して navigate していたが、URL→store は useTabsUrlSync
  // (useLayoutEffect)で一方向同期されているため、逆方向 effect と組み合わせると
  // レンダー closure と store 更新タイミングのずれ(navigate 直後で store が
  // まだ古い等)に、両 effect が互いに古い値をリカバーする navigate を交互に発行し、
  // URL と store が無限に ping-pong した(Chrome の navigation throttle に引っ掛かる
  // ほど高速に)。
  //
  // 代わりに、activeId を変える操作(閉じ・context menu 系)の呼び出し側で
  // navigateToActive() を明示的に呼ぶ設計に統一した。
  const locationRef = useRef(location);
  locationRef.current = location;
  // Ctrl+W ハンドラは effect 内で navigate を使いたい。1回登録の effect が
  // 毎レンダー再登録しないよう ref 経由で参照する(Opus M3: window.history 直叩きを回避)
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Ctrl+W(⌘W): アクティブタブを閉じる。ブラウザデフォルトのタブ閉じは preventDefault で
  // 止められないケースがほとんど(Chrome など)。ここでの preventDefault は「効くかもしれない」
  // 程度の期待値で、実運用は「試すだけ試す」実装。将来別ショートカット案を検討する余地あり。
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.isComposing) return;
      const activePath = getActivePaneActiveIdFromState(useTabsStore.getState());
      if (!activePath) return;
      const modOk = isMac() ? e.metaKey : e.ctrlKey;
      if (!(modOk && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w')) return;
      e.preventDefault();
      // path で tab を探す(活性ペインから)
      const tabsNow = useTabsStore.getState();
      // findLeaf 相当は store 内部関数なので、helper で活性ペインの tabs を取り出して探す
      const activePaneTabs = getActivePaneTabsFromState(tabsNow);
      const target = activePaneTabs.find((t) => t.path === activePath);
      if (!target) return;
      if (target.dirty) {
        useTabsStore.getState().requestClose(activePath);
      } else {
        useTabsStore.getState().closeTab(activePath);
        // 閉じた結果 activeId が変わったら URL 追随。navigate は ref 経由で参照する
        const nextActive = getActivePaneActiveIdFromState(useTabsStore.getState());
        const desired = nextActive ? docUrl(nextActive) : '/';
        if (window.location.pathname !== desired) navigateRef.current(desired);
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // getState() だけ参照するので effect 自体は 1 回登録で十分
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
    // middle click(auxclick も同じイベントだが preventDefault の効きが違う)で閉じる
    if (e.button === 1) {
      e.preventDefault();
      requestOrClose(path);
    }
  }

  // ---- HTML5 D&D による並べ替え ----
  function handleDragStart(e: ReactDragEvent, index: number) {
    setDragIndex(index);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // Firefox は setData がないとドラッグ開始しない
      e.dataTransfer.setData('text/plain', String(index));
    }
  }
  function handleDragOver(e: ReactDragEvent) {
    if (dragIndex === null) return;
    e.preventDefault(); // drop を許可するため必要
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }
  function handleDrop(e: ReactDragEvent, toIndex: number) {
    e.preventDefault();
    if (dragIndex === null) return;
    const dragged = tabs[dragIndex];
    if (dragged) reorder(dragged.path, toIndex);
    setDragIndex(null);
  }
  function handleDragEnd() {
    setDragIndex(null);
  }

  return (
    <>
      <div
        role="tablist"
        aria-label="文書タブ"
        data-testid="tabbar"
        className="flex flex-shrink-0 items-stretch overflow-x-auto border-b border-line bg-panel"
      >
        {tabs.map((tab, index) => {
          const isActive = tab.path === activeId;
          const italic = tab.kind === 'preview' ? 'italic' : '';
          const activeCls = isActive
            ? 'bg-canvas text-ink border-b-2 border-accent'
            : 'text-ink-soft border-b-2 border-transparent hover:bg-hoverbg';
          return (
            <div
              key={tab.path}
              role="tab"
              aria-selected={isActive}
              data-testid={`tab-${tab.path}`}
              title={tab.path}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
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
                  // タブ全体の onClick(activate)より前に閉じる。stopPropagation で親クリックを抑止
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
