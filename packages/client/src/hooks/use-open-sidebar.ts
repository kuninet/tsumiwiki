import { useCallback } from 'react';
import { resolveSideConflict } from '../lib/right-panel-layout';
import { useUIStore } from '../stores/ui';
import { useUserSettingsStore } from '../stores/user-settings';
import { useMediaQuery } from './use-media-query';

/**
 * #322, #271: 左サイドバーを開く共通フック。
 * デスクトップ環境で画面幅が狭い場合、D7の左右排他判定(resolveSideConflict)を実行し、
 * 本文幅が最小幅(400px)を下回る衝突が発生する場合は右パネルを閉じる。
 */
export function useOpenSidebar(): () => void {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const rightPanelOpen = useUserSettingsStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useUserSettingsStore((s) => s.setRightPanelOpen);
  const openSidebarStore = useUIStore((s) => s.openSidebar);

  return useCallback(() => {
    const { sidebarCollapsed, sidebarWidth } = useUIStore.getState();
    if (!sidebarCollapsed) return;

    if (!isMobile) {
      const conflict = resolveSideConflict({
        innerWidth: typeof window !== 'undefined' ? window.innerWidth : 1280,
        sidebarWidth,
        leftOpen: false,
        rightOpen: rightPanelOpen,
        justOpened: 'left',
      });
      if (conflict === 'close-right') {
        setRightPanelOpen(false);
      }
    }
    openSidebarStore();
  }, [isMobile, rightPanelOpen, setRightPanelOpen, openSidebarStore]);
}
