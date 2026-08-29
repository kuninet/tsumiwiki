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
  // AppShellのサイドバーフッターの📝ボタンや Ctrl+N ショートカットから
  // FolderTree の新規文書ダイアログを開かせるための要求。
  // nonce は毎回インクリメントし、folder に初期フォルダを載せる
  // (nonce だけでは連続要求で同じ folder を再指定できないため)
  createDocRequest: { nonce: number; folder: string };
  setSidebarWidth: (width: number) => void;
  toggleSidebarCollapsed: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  toggleFolderExpanded: (path: string) => void;
  // フォルダ移動・リネーム時の展開状態の付け替え。oldPath/配下の展開もまとめて newPath/配下に付け替える
  repathExpandedFolder: (oldPath: string, newPath: string) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  requestCreateDoc: (folder?: string) => void;
}

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

// 初回描画のちらつき(モバイルで開いた状態→畳んだ状態のアニメーションが走る)を避けるため、
// ストア初期化時点で狭幅判定を済ませ、モバイルであれば初期状態から折畳とする
function initialSidebarCollapsed(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(max-width: 767px)').matches;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  sidebarCollapsed: initialSidebarCollapsed(),
  sidebarTab: 'folder',
  expandedFolders: new Set(),
  selectedTags: [],
  createDocRequest: { nonce: 0, folder: '' },
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
  repathExpandedFolder: (oldPath, newPath) =>
    set((s) => {
      if (oldPath === newPath) return {};
      const next = new Set<string>();
      let changed = false;
      const oldPrefix = `${oldPath}/`;
      for (const p of s.expandedFolders) {
        if (p === oldPath) {
          next.add(newPath);
          changed = true;
        } else if (p.startsWith(oldPrefix)) {
          next.add(newPath + p.slice(oldPath.length));
          changed = true;
        } else {
          next.add(p);
        }
      }
      return changed ? { expandedFolders: next } : {};
    }),
  toggleTag: (tag) =>
    set((s) => ({
      selectedTags: s.selectedTags.includes(tag)
        ? s.selectedTags.filter((t) => t !== tag)
        : [...s.selectedTags, tag],
    })),
  clearTags: () => set({ selectedTags: [] }),
  requestCreateDoc: (folder = '') =>
    set((s) => ({
      sidebarTab: 'folder',
      createDocRequest: { nonce: s.createDocRequest.nonce + 1, folder },
    })),
}));
