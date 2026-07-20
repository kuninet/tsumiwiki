import { create } from 'zustand';

// 編集/閲覧のタブモデル(Epic #133 / Phase A-1)。
// VSCode 風の「プレビュー(1タブ使い回し) / 固定(明示ピン) / dirty(編集あり=固定相当)」を実現する。
// タブ ID は path そのものにする(1文書=最大1タブ)。開いていないタブがまた開かれると
// 新規に preview として扱われる(必要なら固定される)。

export type TabKind = 'preview' | 'pinned';

export interface Tab {
  // 文書パス(そのままIDとしても使う)
  path: string;
  kind: TabKind;
  // 未保存編集ありなら true。表示上「●」を先頭に付与する。
  // dirty のタブは kind='preview' でも「次に開いた文書に上書きされない」扱いにする
  dirty: boolean;
}

interface TabsState {
  tabs: Tab[];
  activeId: string | null;

  // 文書を開く。preview を再利用/新規作成する。activate=false で背景タブ化も可能(将来用)。
  // 既に開かれていれば activate だけ行う(kind は保持)
  openDoc: (path: string, opts?: { pinned?: boolean; activate?: boolean }) => void;

  // タブをアクティブにする(存在しないIDは無視)
  setActive: (path: string) => void;

  // プレビューを固定タブへ昇格(ダブルクリック等のエントリ)
  promoteToPinned: (path: string) => void;

  // dirty フラグ更新。true にすると同時に kind='pinned' に昇格する
  markDirty: (path: string, dirty: boolean) => void;

  // 全タブ破棄(テスト用)
  reset: () => void;
}

// 「置換対象になる preview」= dirty ではない preview タブ
function findReplaceablePreview(tabs: Tab[]): Tab | null {
  return tabs.find((t) => t.kind === 'preview' && !t.dirty) ?? null;
}

export const useTabsStore = create<TabsState>((set) => ({
  tabs: [],
  activeId: null,

  openDoc: (path, opts) => {
    const activate = opts?.activate !== false;
    set((s) => {
      const existing = s.tabs.find((t) => t.path === path);
      if (existing) {
        // 既存タブがあればアクティブにするだけ。opts.pinned=true なら preview→pinned に昇格する
        const nextTabs = opts?.pinned && existing.kind === 'preview'
          ? s.tabs.map((t) => (t.path === path ? { ...t, kind: 'pinned' as const } : t))
          : s.tabs;
        return {
          tabs: nextTabs,
          activeId: activate ? path : s.activeId,
        };
      }

      // 新規タブ。既存の preview を置換するのが基本(閲覧タブが際限なく増えないため)。
      // ただし明示的に pinned で開かれた場合、または置換候補が無ければ末尾追加
      const preview = opts?.pinned ? null : findReplaceablePreview(s.tabs);
      const newTab: Tab = { path, kind: opts?.pinned ? 'pinned' : 'preview', dirty: false };

      const nextTabs = preview
        ? s.tabs.map((t) => (t.path === preview.path ? newTab : t))
        : [...s.tabs, newTab];

      return {
        tabs: nextTabs,
        activeId: activate ? path : s.activeId,
      };
    });
  },

  setActive: (path) => {
    set((s) => (s.tabs.some((t) => t.path === path) ? { activeId: path } : {}));
  },

  promoteToPinned: (path) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, kind: 'pinned' as const } : t)),
    }));
  },

  markDirty: (path, dirty) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.path === path);
      if (idx === -1) return {};
      const current = s.tabs[idx];
      if (current.dirty === dirty && (!dirty || current.kind === 'pinned')) {
        // 変化なし
        return {};
      }
      const next = [...s.tabs];
      next[idx] = {
        ...current,
        dirty,
        // dirty=true になったら固定タブに昇格する(閲覧遷移で上書きされなくなる)
        kind: dirty ? 'pinned' : current.kind,
      };
      return { tabs: next };
    });
  },

  reset: () => set({ tabs: [], activeId: null }),
}));
