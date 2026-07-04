import { create } from 'zustand';

// AppShellのサイドバー状態(設計04章4.3)。幅ドラッグ・折りたたみ・タブ切替を保持する

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 260; // 設計04章4.6: サイドバー260px既定

export type SidebarTab = 'folder' | 'tag';

interface UIState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  sidebarTab: SidebarTab;
  setSidebarWidth: (width: number) => void;
  toggleSidebarCollapsed: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
}

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

export const useUIStore = create<UIState>((set) => ({
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  sidebarCollapsed: false,
  sidebarTab: 'folder',
  setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
  toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
}));
