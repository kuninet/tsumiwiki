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
  // AppShellのサイドバーフッター「+ 新規文書」や Ctrl+N ショートカットから
  // FolderTree の新規文書ダイアログを開かせるための要求。
  // nonce は毎回インクリメントし、folder に初期フォルダを載せる
  // (nonce だけでは連続要求で同じ folder を再指定できないため)
  createDocRequest: { nonce: number; folder: string };
  // 文書オープン直後(即編集モード時)は false。ユーザーが編集操作を始めた時点で true。
  // DocView 側で本文への click/keydown/touchstart/paste を検知したら showEditorChrome を呼ぶ。
  // 別文書へ遷移するときは resetEditorChrome で false に戻す。
  editorChromeVisible: boolean;
  setSidebarWidth: (width: number) => void;
  toggleSidebarCollapsed: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  toggleFolderExpanded: (path: string) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  requestCreateDoc: (folder?: string) => void;
  showEditorChrome: () => void;
  resetEditorChrome: () => void;
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
  editorChromeVisible: false,
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
  requestCreateDoc: (folder = '') =>
    set((s) => ({
      sidebarTab: 'folder',
      createDocRequest: { nonce: s.createDocRequest.nonce + 1, folder },
    })),
  showEditorChrome: () => set({ editorChromeVisible: true }),
  resetEditorChrome: () => set({ editorChromeVisible: false }),
}));
