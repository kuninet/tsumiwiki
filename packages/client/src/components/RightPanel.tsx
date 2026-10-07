import { X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useHorizontalResize } from '../hooks/use-horizontal-resize';
import { useMediaQuery } from '../hooks/use-media-query';
import {
  isDocRoute,
  useRightPanelActions,
  useRightPanelContentVisible,
} from '../hooks/use-right-panel';
import { useWindowWidth } from '../hooks/use-window-width';
import {
  computeRightPanelWidth,
  RIGHT_PANEL_MAX_WIDTH,
  rightPanelMaxWidth,
} from '../lib/right-panel-layout';
import { useUIStore } from '../stores/ui';
import {
  type RightPanelTab,
  useUserSettingsStore,
} from '../stores/user-settings';

// #271: 右パネルで提供するタブ一覧(バックリンク・履歴)
export const RIGHT_PANEL_TABS: readonly RightPanelTab[] = ['backlinks', 'history'] as const;

export const RIGHT_PANEL_TAB_LABELS: Record<RightPanelTab, string> = {
  backlinks: 'バックリンク',
  history: '履歴',
};

export function RightPanel() {
  const asideRef = useRef<HTMLElement>(null);
  const location = useLocation();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const innerWidth = useWindowWidth();

  const rightPanelWidth = useUserSettingsStore((s) => s.rightPanelWidth);
  const rightPanelTab = useUserSettingsStore((s) => s.rightPanelTab);
  const setRightPanelTab = useUserSettingsStore((s) => s.setRightPanelTab);
  const setRightPanelWidth = useUserSettingsStore((s) => s.setRightPanelWidth);

  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const rightDrawerOpen = useUIStore((s) => s.rightDrawerOpen);
  const setRightPanelSlot = useUIStore((s) => s.setRightPanelSlot);

  const { closeRightPanel } = useRightPanelActions();
  const isContentVisible = useRightPanelContentVisible();

  // 幅ドラッグリサイズ(デスクトップ)
  const handleResize = useCallback(
    (rawWidth: number) => {
      const { sidebarWidth: sbWidth, sidebarCollapsed: sbCollapsed } = useUIStore.getState();
      const maxLimit = rightPanelMaxWidth({
        innerWidth: typeof window !== 'undefined' ? window.innerWidth : 1280,
        leftWidth: !sbCollapsed ? sbWidth : 0,
      });
      const widthToStore = Math.min(rawWidth, Math.min(RIGHT_PANEL_MAX_WIDTH, maxLimit));
      setRightPanelWidth(widthToStore);
    },
    [setRightPanelWidth],
  );

  const { onMouseDown: onResizeMouseDown } = useHorizontalResize({
    side: 'right',
    onResize: handleResize,
  });

  // 描画時の幅計算(D6)
  const computedWidth = computeRightPanelWidth(rightPanelWidth, {
    innerWidth,
    leftWidth: !sidebarCollapsed ? sidebarWidth : 0,
  });

  // Escape キーによる閉じる処理(D3, D9, C-5-5〜C-5-7, C-7-16)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      // 確認ダイアログ等[role="dialog"]内の Escape はダイアログ優先で無視
      if (target?.closest?.('[role="dialog"]')) return;

      if (isMobile) {
        // モバイルではドロワーが開いていればフォーカス位置に関わらず閉じる
        if (useUIStore.getState().rightDrawerOpen) {
          closeRightPanel();
        }
      } else {
        // デスクトップでは asideRef 内にフォーカスがあるときだけ閉じる
        if (asideRef.current?.contains(target)) {
          closeRightPanel();
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMobile, closeRightPanel]);

  const showContent = isContentVisible && isDocRoute(location.pathname);

  return (
    <aside
      ref={asideRef}
      data-testid="right-panel"
      style={isMobile ? undefined : { width: computedWidth }}
      className={
        isMobile
          ? `fixed inset-y-0 right-0 z-40 flex w-[340px] max-w-[85vw] flex-col border-l border-line bg-panel shadow-xl transition-transform duration-200 ${
              rightDrawerOpen ? 'translate-x-0' : 'translate-x-full'
            }`
          : 'relative flex flex-shrink-0 flex-col border-l border-line bg-panel'
      }
    >
      {!isMobile && (
        <div
          data-testid="right-panel-resize-handle"
          onMouseDown={onResizeMouseDown}
          className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent-soft"
        />
      )}

      {/* タブヘッダー */}
      <div className="flex flex-shrink-0 items-center border-b border-line" role="tablist">
        {RIGHT_PANEL_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={rightPanelTab === tab}
            onClick={() => setRightPanelTab(tab)}
            className={`flex-1 px-3 py-2 text-sm ${
              rightPanelTab === tab
                ? 'bg-active font-semibold text-accent'
                : 'text-ink-faint hover:text-ink'
            }`}
          >
            {RIGHT_PANEL_TAB_LABELS[tab]}
          </button>
        ))}
        <button
          type="button"
          onClick={closeRightPanel}
          aria-label="右パネルを閉じる"
          className="flex h-8 w-8 items-center justify-center text-ink-faint hover:text-ink hover:bg-hoverbg"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      {/* パネル本体領域 */}
      <div className="relative flex flex-1 flex-col min-h-0 overflow-hidden">
        {!showContent && (
          <div
            data-testid="right-panel-empty"
            className="p-4 text-center text-sm text-ink-faint"
          >
            文書を開くとここに表示されます
          </div>
        )}
        <div
          data-testid="right-panel-slot"
          ref={setRightPanelSlot}
          className={`flex-1 min-h-0 overflow-y-auto ${!showContent ? 'hidden' : ''}`}
        />
      </div>
    </aside>
  );
}
