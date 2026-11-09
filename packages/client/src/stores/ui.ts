import { create } from 'zustand';
import { ancestorFolderPaths } from '../lib/build-tree';

// AppShellのサイドバー状態(設計04章4.3)。幅ドラッグ・折りたたみ・タブ切替・
// フォルダツリーの展開状態・タグ絞り込みの選択状態を保持する

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 260; // 設計04章4.6: サイドバー260px既定

export type SidebarTab = 'folder' | 'tag';

// #323: 祖先フォルダ展開のオプション
export interface ExpandAncestorsOptions {
  // path がフォルダのとき true。既定 false(文書)
  isFolder?: boolean;
  // isFolder のとき、そのフォルダ自身も展開する。既定 false。
  // 文書(isFolder=false)のときは無視する
  includeSelf?: boolean;
}

// #323: ツリーで表示するときのオプション。#322 / #324 からも使う
export interface RevealInTreeOptions extends ExpandAncestorsOptions {
  // サイドバーのタブを 'folder' に切り替える。既定 false。
  // 自動追従では false(利用者がタグタブを見ているときに勝手に切り替えない)。
  // パンくず(#322)・手動表示ボタン(#324)など明示操作では true
  activateTab?: boolean;
  // 行に DOM フォーカスを移す。既定 false。
  // 自動追従では false(エディタのフォーカスを奪わない)。明示操作では true を推奨
  focus?: boolean;
}

// #323: FolderTree に「この行までスクロールして」と伝える要求。
// FolderTree が消費したら null に戻す(consumeRevealRequest)
export interface RevealRequest {
  nonce: number;
  path: string;
  isFolder: boolean;
  focus: boolean;
}

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
  // #323: ツリーの該当行へのスクロール要求。null なら要求なし。
  // FolderTree が unmount 中(タグタブ・デスクトップ折畳)でも残り、次のマウント時に消費される
  revealRequest: RevealRequest | null;
  // #271: モバイル用右ドロワー開閉状態
  rightDrawerOpen: boolean;
  // #271: 右パネルの描画スロット DOM 要素(DocView 等からのポータル先)
  rightPanelSlot: HTMLElement | null;
  setSidebarWidth: (width: number) => void;
  toggleSidebarCollapsed: () => void;
  // #322: サイドバーを開く(折りたたまれていれば解除し、右ドロワーを閉じる。既に開いていれば no-op)
  openSidebar: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setRightDrawerOpen: (open: boolean) => void;
  setRightPanelSlot: (el: HTMLElement | null) => void;
  toggleFolderExpanded: (path: string) => void;
  // フォルダ移動・リネーム時の展開状態の付け替え。oldPath/配下の展開もまとめて newPath/配下に付け替える
  repathExpandedFolder: (oldPath: string, newPath: string) => void;
  // #323: path の祖先フォルダをすべて展開する。既存の展開状態は閉じない(追加のみ)。
  // 追加するものが無ければ state を変えない(expandedFolders の参照も変えない)
  expandAncestors: (path: string, options?: ExpandAncestorsOptions) => void;
  // #323: 祖先フォルダを展開し、FolderTree に該当行までのスクロールを要求する。
  // 展開・タブ切替・要求の登録は1回の set で行う(同じ描画で行が DOM に出るようにするため)
  revealInTree: (path: string, options?: RevealInTreeOptions) => void;
  // #323: nonce が今の revealRequest と一致するときだけ null に戻す。
  // 消費中に新しい要求が来ていたら、そちらを消さない
  consumeRevealRequest: (nonce: number) => void;
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

// #323: nonce の採番。revealRequest を null に戻しても番号が巻き戻らないよう、ストア外に持つ
let revealSeq = 0;

// 展開すべきフォルダを current に足した Set を返す。足すものが無ければ null
function withAncestorsExpanded(
  current: Set<string>,
  path: string,
  options?: ExpandAncestorsOptions,
): Set<string> | null {
  const targets = ancestorFolderPaths(path);
  const self = path.replace(/^\/+|\/+$/g, '');
  if (options?.isFolder && options.includeSelf && self) targets.push(self);
  const missing = targets.filter((p) => !current.has(p));
  if (missing.length === 0) return null;
  const next = new Set(current);
  for (const p of missing) next.add(p);
  return next;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  sidebarCollapsed: initialSidebarCollapsed(),
  sidebarTab: 'folder',
  expandedFolders: new Set(),
  selectedTags: [],
  createDocRequest: { nonce: 0, folder: '' },
  revealRequest: null,
  rightDrawerOpen: false,
  rightPanelSlot: null,
  setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
  // #271: 開く方向(collapsed -> false)なら右ドロワーを閉じる(左右排他)
  toggleSidebarCollapsed: () =>
    set((s) => {
      const willOpen = s.sidebarCollapsed;
      return {
        sidebarCollapsed: !s.sidebarCollapsed,
        ...(willOpen ? { rightDrawerOpen: false } : {}),
      };
    }),
  // #322: サイドバーを開く(折りたたまれていれば解除し、右ドロワーを閉じる。既に開いていれば no-op)
  openSidebar: () =>
    set((s) => (s.sidebarCollapsed ? { sidebarCollapsed: false, rightDrawerOpen: false } : {})),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  // #271: 右ドロワーを開く(true)なら左サイドバーを折りたたむ(左右排他)
  setRightDrawerOpen: (open) =>
    set({
      rightDrawerOpen: open,
      ...(open ? { sidebarCollapsed: true } : {}),
    }),
  setRightPanelSlot: (el) => set({ rightPanelSlot: el }),
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
  expandAncestors: (path, options) =>
    set((s) => {
      const next = withAncestorsExpanded(s.expandedFolders, path, options);
      return next ? { expandedFolders: next } : {};
    }),
  revealInTree: (path, options) =>
    set((s) => {
      const normalized = path.replace(/^\/+|\/+$/g, '');
      const next = withAncestorsExpanded(s.expandedFolders, normalized, options);
      revealSeq += 1;
      return {
        ...(next ? { expandedFolders: next } : {}),
        ...(options?.activateTab ? { sidebarTab: 'folder' as const } : {}),
        revealRequest: {
          nonce: revealSeq,
          path: normalized,
          isFolder: options?.isFolder ?? false,
          focus: options?.focus ?? false,
        },
      };
    }),
  consumeRevealRequest: (nonce) =>
    set((s) => (s.revealRequest?.nonce === nonce ? { revealRequest: null } : {})),
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
