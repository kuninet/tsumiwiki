import { useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { resolveSideConflict } from '../lib/right-panel-layout';
import { useUIStore } from '../stores/ui';
import { type RightPanelTab, useUserSettingsStore } from '../stores/user-settings';
import { useMediaQuery } from './use-media-query';

// #271: 右パネルのルート判定
export function isMainRoute(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/doc/');
}

export function isDocRoute(pathname: string): boolean {
  return pathname.startsWith('/doc/');
}

// モバイル/デスクトップに応じた開閉状態
export function useIsRightPanelOpen(): boolean {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const rightPanelOpen = useUserSettingsStore((s) => s.rightPanelOpen);
  const rightDrawerOpen = useUIStore((s) => s.rightDrawerOpen);
  return isMobile ? rightDrawerOpen : rightPanelOpen;
}

// パネル内容(スロットへのポータル描画・空状態判定)の表示可否(D8)
export function useRightPanelContentVisible(): boolean {
  const location = useLocation();
  const isOpen = useIsRightPanelOpen();
  return isDocRoute(location.pathname) && isOpen;
}

// モバイルでドロワーを開く際、仮想キーボードやエディタツールバーの重なりを防ぐため blur する(D13)
function blurActiveInput() {
  if (typeof document === 'undefined') return;
  const active = document.activeElement;
  if (!active) return;
  if (
    active.closest('.ProseMirror') ||
    active.tagName === 'TEXTAREA' ||
    active.tagName === 'INPUT'
  ) {
    (active as HTMLElement).blur();
  }
}

// 右パネルの操作アクション集約フック(D8)
export function useRightPanelActions() {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const setRightPanelTab = useUserSettingsStore((s) => s.setRightPanelTab);
  const setRightPanelOpen = useUserSettingsStore((s) => s.setRightPanelOpen);
  const setRightDrawerOpen = useUIStore((s) => s.setRightDrawerOpen);

  const openRightPanel = useCallback(
    (tab?: RightPanelTab) => {
      if (tab) {
        setRightPanelTab(tab);
      }
      if (isMobile) {
        blurActiveInput();
        setRightDrawerOpen(true);
      } else {
        const { sidebarWidth, sidebarCollapsed } = useUIStore.getState();
        const conflict = resolveSideConflict({
          innerWidth: typeof window !== 'undefined' ? window.innerWidth : 1280,
          sidebarWidth,
          leftOpen: !sidebarCollapsed,
          rightOpen: false,
          justOpened: 'right',
        });
        if (conflict === 'close-left') {
          useUIStore.setState({ sidebarCollapsed: true });
        }
        setRightPanelOpen(true);
      }
    },
    [isMobile, setRightDrawerOpen, setRightPanelOpen, setRightPanelTab],
  );

  const closeRightPanel = useCallback(() => {
    if (isMobile) {
      setRightDrawerOpen(false);
    } else {
      setRightPanelOpen(false);
    }
  }, [isMobile, setRightDrawerOpen, setRightPanelOpen]);

  const toggleRightPanel = useCallback(() => {
    if (isMobile) {
      const current = useUIStore.getState().rightDrawerOpen;
      if (!current) {
        openRightPanel();
      } else {
        setRightDrawerOpen(false);
      }
    } else {
      const current = useUserSettingsStore.getState().rightPanelOpen;
      if (!current) {
        openRightPanel();
      } else {
        setRightPanelOpen(false);
      }
    }
  }, [isMobile, openRightPanel, setRightDrawerOpen, setRightPanelOpen]);

  return {
    openRightPanel,
    closeRightPanel,
    toggleRightPanel,
  };
}
