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
  // Phase A-2: dirty タブの閉じ確認中に「どのタブを閉じようとしているか」を保持する。
  // 非 null の間 CloseConfirmDialog が表示される
  pendingCloseId: string | null;

  // 文書を開く。preview を再利用/新規作成する。activate=false で背景タブ化も可能(将来用)。
  // 既に開かれていれば activate だけ行う(kind は保持)
  openDoc: (path: string, opts?: { pinned?: boolean; activate?: boolean }) => void;

  // タブをアクティブにする(存在しないIDは無視)
  setActive: (path: string) => void;

  // プレビューを固定タブへ昇格(ダブルクリック等のエントリ)
  promoteToPinned: (path: string) => void;

  // 固定→プレビューに戻す(明示 unpin。dirty のときは preview に戻しても上書きされないので実質固定のまま)
  unpin: (path: string) => void;

  // dirty フラグ更新。true にすると同時に kind='pinned' に昇格する
  markDirty: (path: string, dirty: boolean) => void;

  // タブを閉じる。アクティブタブが閉じられたら隣(右→左)を新アクティブにする
  closeTab: (path: string) => void;

  // Phase A-2: 「他をすべて閉じる」「右側をすべて閉じる」「すべて閉じる」
  // dirty のタブは caller 側で確認済み(または明示的に含めない)ことを想定するが、
  // ここでは呼ばれたものを機械的に閉じる。UI 層で confirm を出す
  closeOthers: (keepPath: string) => void;
  closeToRight: (fromPath: string) => void;
  closeAll: () => void;

  // 同一ペイン内でのタブ並べ替え(D&D 実装用)。範囲外の index は無視
  reorder: (fromIndex: number, toIndex: number) => void;

  // dirty タブ閉じ確認ダイアログの制御
  requestClose: (path: string) => void;
  cancelClose: () => void;

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
  pendingCloseId: null,

  openDoc: (path, opts) => {
    const activate = opts?.activate !== false;
    set((s) => {
      const existing = s.tabs.find((t) => t.path === path);
      if (existing) {
        const nextTabs = opts?.pinned && existing.kind === 'preview'
          ? s.tabs.map((t) => (t.path === path ? { ...t, kind: 'pinned' as const } : t))
          : s.tabs;
        return {
          tabs: nextTabs,
          activeId: activate ? path : s.activeId,
        };
      }

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

  unpin: (path) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, kind: 'preview' as const } : t)),
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

  closeTab: (path) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.path === path);
      if (idx === -1) return {};
      const nextTabs = [...s.tabs.slice(0, idx), ...s.tabs.slice(idx + 1)];
      const wasActive = s.activeId === path;
      let nextActive = s.activeId;
      if (wasActive) {
        // 右側があれば右側の先頭を、無ければ左側の末尾を新アクティブに。両方無ければ null
        nextActive = nextTabs[idx]?.path ?? nextTabs[idx - 1]?.path ?? null;
      }
      // 閉じたタブが pendingCloseId 対象なら pendingCloseId もクリア
      const nextPending = s.pendingCloseId === path ? null : s.pendingCloseId;
      return { tabs: nextTabs, activeId: nextActive, pendingCloseId: nextPending };
    });
  },

  closeOthers: (keepPath) => {
    set((s) => {
      const kept = s.tabs.find((t) => t.path === keepPath);
      if (!kept) return {};
      // pending が残す側でなければクリア(keepPath なら維持)
      return {
        tabs: [kept],
        activeId: keepPath,
        pendingCloseId: s.pendingCloseId === keepPath ? keepPath : null,
      };
    });
  },

  closeToRight: (fromPath) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.path === fromPath);
      if (idx === -1) return {};
      const nextTabs = s.tabs.slice(0, idx + 1);
      // active が閉じた範囲にあれば基準の fromPath をアクティブに
      const activeStillOpen = nextTabs.some((t) => t.path === s.activeId);
      const pendingStillOpen = s.pendingCloseId
        ? nextTabs.some((t) => t.path === s.pendingCloseId)
        : false;
      return {
        tabs: nextTabs,
        activeId: activeStillOpen ? s.activeId : fromPath,
        pendingCloseId: pendingStillOpen ? s.pendingCloseId : null,
      };
    });
  },

  closeAll: () => set({ tabs: [], activeId: null, pendingCloseId: null }),

  reorder: (fromIndex, toIndex) => {
    set((s) => {
      if (
        fromIndex < 0 ||
        fromIndex >= s.tabs.length ||
        toIndex < 0 ||
        toIndex >= s.tabs.length ||
        fromIndex === toIndex
      ) {
        return {};
      }
      const nextTabs = [...s.tabs];
      const [moved] = nextTabs.splice(fromIndex, 1);
      nextTabs.splice(toIndex, 0, moved);
      return { tabs: nextTabs };
    });
  },

  requestClose: (path) => set({ pendingCloseId: path }),
  cancelClose: () => set({ pendingCloseId: null }),

  reset: () => set({ tabs: [], activeId: null, pendingCloseId: null }),
}));
