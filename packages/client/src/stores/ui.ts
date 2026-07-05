import { create } from 'zustand';

// AppShellのサイドバー状態(設計04章4.3)。幅ドラッグ・折りたたみ・タブ切替・
// フォルダツリーの展開状態・タグ絞り込みの選択状態を保持する

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 260; // 設計04章4.6: サイドバー260px既定

export type SidebarTab = 'folder' | 'tag';

interface UIState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  sidebarTab: SidebarTab;
  expandedFolders: Set<string>;
  selectedTags: string[];
  // AppShellのサイドバーフッター「+ 新規文書」から FolderTree の新規文書ダイアログを
  // 開かせるためのnonce(FolderTreeマウント側がuseEffectで拾ってダイアログを開く)
  createDocRequestNonce: number;
  setSidebarWidth: (width: number) => void;
  toggleSidebarCollapsed: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  toggleFolderExpanded: (path: string) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  requestCreateDoc: () => void;
}

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

export const useUIStore = create<UIState>((set) => ({
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  sidebarCollapsed: false,
  sidebarTab: 'folder',
  expandedFolders: new Set(),
  selectedTags: [],
  createDocRequestNonce: 0,
  setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
  toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  toggleFolderExpanded: (path) =>
    set((s) => {
      const next = new Set(s.expandedFolders);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return { expandedFolders: next };
    }),
  toggleTag: (tag) =>
    set((s) => ({
      selectedTags: s.selectedTags.includes(tag)
        ? s.selectedTags.filter((t) => t !== tag)
        : [...s.selectedTags, tag],
    })),
  clearTags: () => set({ selectedTags: [] }),
  requestCreateDoc: () =>
    set((s) => ({ sidebarTab: 'folder', createDocRequestNonce: s.createDocRequestNonce + 1 })),
}));
