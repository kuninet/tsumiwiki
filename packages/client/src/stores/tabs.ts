import { create } from 'zustand';

// 編集/閲覧のタブモデル(Epic #133 / Phase A-1 + A-2 + B)。
// VSCode 風の「プレビュー(1タブ使い回し) / 固定(明示ピン) / dirty(編集あり=固定相当)」を実現する。
// Phase B: 単一ペインを二分木のレイアウトツリーに拡張し、左右/上下分割で複数文書を並べて表示できる。
//
// 設計方針:
// - 1 文書 = 全ペインで最大 1 タブ(path で一意)。ペイン間のドラッグは「移動」であって複製ではない
// - store の外向き API は「path 中心」。呼び出し側は原則 paneId を意識しなくてよい
//   openDoc / closeTab / markDirty などは path から所属ペインを引く
// - splitPane 系だけ paneId を扱う(ドロップ先ペインの指定が必要なため)

export type TabKind = 'preview' | 'pinned';

export interface Tab {
  path: string;
  kind: TabKind;
  dirty: boolean;
}

export type PaneId = string;
export type SplitDir = 'row' | 'column';

export interface LeafPane {
  kind: 'leaf';
  id: PaneId;
  tabs: Tab[];
  activeId: string | null;
}

export interface SplitPane {
  kind: 'split';
  id: PaneId;
  dir: SplitDir;
  a: PaneNode;
  b: PaneNode;
  // a のサイズ比率(0-1)。b は 1-ratio
  ratio: number;
}

export type PaneNode = LeafPane | SplitPane;

interface PendingClose {
  paneId: PaneId;
  path: string;
}

interface TabsState {
  root: PaneNode;
  activePaneId: PaneId;
  pendingClose: PendingClose | null;

  // ------ path 中心 API(呼び出し側は paneId を意識しない) ------

  // 開く。既に存在すれば所属ペインへアクティブ切替 + そのペインをアクティブに。
  // 存在しなければ activePane に preview として作成(preview 置換ルール適用)
  openDoc: (path: string, opts?: { pinned?: boolean; activate?: boolean }) => void;

  // path から所属ペインを引いてアクティブにする
  setActive: (path: string) => void;

  promoteToPinned: (path: string) => void;
  unpin: (path: string) => void;
  markDirty: (path: string, dirty: boolean) => void;
  closeTab: (path: string) => void;
  closeOthers: (keepPath: string) => void;
  closeToRight: (fromPath: string) => void;

  // すべてのペインの全タブを閉じ、単一 leaf にリセット
  closeAll: () => void;

  // 同一ペイン内での並べ替え(path を持つペインの中で from→to)
  reorder: (path: string, toIndex: number) => void;

  requestClose: (path: string) => void;
  cancelClose: () => void;

  // ------ ペイン操作(Phase B 追加) ------

  // path が置かれているペインが activePane でない場合の切替エントリ
  setActivePane: (paneId: PaneId) => void;

  // 分割 or 移動。position='center' は同一ペイン内アクティブ切替と等価だが、
  // 別ペインへの center ドロップは対象ペインへ移動する。
  // left/right/top/bottom は対象ペインを分割し、新レイアウトの反対側に path を移す
  splitOrMove: (
    sourcePath: string,
    targetPaneId: PaneId,
    position: 'left' | 'right' | 'top' | 'bottom' | 'center',
  ) => void;

  setPaneRatio: (splitId: PaneId, ratio: number) => void;

  reset: () => void;
}

// ------ 純関数ヘルパー(reducer 的用途) ------

let paneCounter = 0;
function nextPaneId(): PaneId {
  paneCounter += 1;
  return `p${paneCounter}`;
}

function emptyLeaf(): LeafPane {
  return { kind: 'leaf', id: nextPaneId(), tabs: [], activeId: null };
}

// path で tab を持つ leaf を探す
function findLeafByPath(node: PaneNode, path: string): LeafPane | null {
  if (node.kind === 'leaf') {
    return node.tabs.some((t) => t.path === path) ? node : null;
  }
  return findLeafByPath(node.a, path) ?? findLeafByPath(node.b, path);
}

function findLeafById(node: PaneNode, id: PaneId): LeafPane | null {
  if (node.kind === 'leaf') return node.id === id ? node : null;
  return findLeafById(node.a, id) ?? findLeafById(node.b, id);
}

function allLeaves(node: PaneNode): LeafPane[] {
  if (node.kind === 'leaf') return [node];
  return [...allLeaves(node.a), ...allLeaves(node.b)];
}

// tree 内の leaf を id 一致で置き換える。root ごと差し替えたい場合は呼び出し側で処理
function replaceLeaf(node: PaneNode, id: PaneId, replacement: PaneNode): PaneNode {
  if (node.kind === 'leaf') {
    return node.id === id ? replacement : node;
  }
  return {
    ...node,
    a: replaceLeaf(node.a, id, replacement),
    b: replaceLeaf(node.b, id, replacement),
  };
}

// leaf を id で更新する(kind='leaf' を維持)
function updateLeaf(
  node: PaneNode,
  id: PaneId,
  updater: (leaf: LeafPane) => LeafPane,
): PaneNode {
  if (node.kind === 'leaf') return node.id === id ? updater(node) : node;
  return { ...node, a: updateLeaf(node.a, id, updater), b: updateLeaf(node.b, id, updater) };
}

// 空 leaf を tree から取り除き、split の反対側で置換する。root が空 leaf なら空 leaf を返す
function pruneEmpty(node: PaneNode): PaneNode {
  if (node.kind === 'leaf') return node;
  const a = pruneEmpty(node.a);
  const b = pruneEmpty(node.b);
  if (a.kind === 'leaf' && a.tabs.length === 0 && b.kind === 'leaf' && b.tabs.length === 0) {
    // 両側とも空になる遷移は現行 mutator(closeTab / splitOrMove)からは生じないため
    // 実質デッドコード。B2 以降で「ペインごと閉じる」等が入ったときのための保険として残す
    return a;
  }
  if (a.kind === 'leaf' && a.tabs.length === 0) return b;
  if (b.kind === 'leaf' && b.tabs.length === 0) return a;
  return { ...node, a, b };
}

// 「置換対象になる preview」= dirty ではない preview タブ(ペイン内で)
function findReplaceablePreview(pane: LeafPane): Tab | null {
  return pane.tabs.find((t) => t.kind === 'preview' && !t.dirty) ?? null;
}

// pane から path のタブを外す。空になったら activeId=null にするが leaf 自体は返す
function removeTabFromPane(pane: LeafPane, path: string): LeafPane {
  const idx = pane.tabs.findIndex((t) => t.path === path);
  if (idx === -1) return pane;
  const nextTabs = [...pane.tabs.slice(0, idx), ...pane.tabs.slice(idx + 1)];
  const wasActive = pane.activeId === path;
  const nextActive = wasActive
    ? (nextTabs[idx]?.path ?? nextTabs[idx - 1]?.path ?? null)
    : pane.activeId;
  return { ...pane, tabs: nextTabs, activeId: nextActive };
}

// pane に tab を差し込む。既存の同 path があれば置換
function addTabToPane(pane: LeafPane, tab: Tab, activate: boolean): LeafPane {
  const existingIdx = pane.tabs.findIndex((t) => t.path === tab.path);
  if (existingIdx !== -1) {
    return { ...pane, activeId: activate ? tab.path : pane.activeId };
  }
  return {
    ...pane,
    tabs: [...pane.tabs, tab],
    activeId: activate ? tab.path : (pane.activeId ?? tab.path),
  };
}

function initialState(): Pick<TabsState, 'root' | 'activePaneId' | 'pendingClose'> {
  paneCounter = 0;
  const leaf = emptyLeaf();
  return { root: leaf, activePaneId: leaf.id, pendingClose: null };
}

export const useTabsStore = create<TabsState>((set, get) => ({
  ...initialState(),

  openDoc: (path, opts) => {
    const activate = opts?.activate !== false;
    set((s) => {
      // 既に存在するペインを探す
      const existingPane = findLeafByPath(s.root, path);
      if (existingPane) {
        const existingTab = existingPane.tabs.find((t) => t.path === path)!;
        const needsPin = !!opts?.pinned && existingTab.kind === 'preview';
        const needsActive = activate && existingPane.activeId !== path;
        const needsActivePane = activate && s.activePaneId !== existingPane.id;
        // すべて既に整っていれば no-op(URL 変化のたびに useTabsUrlSync から
        // 呼ばれるので、無駄に root オブジェクトを差し替えて subscriber を発火させない
        // ようにする — Opus M2)
        if (!needsPin && !needsActive && !needsActivePane) return {};
        const nextRoot =
          needsPin || needsActive
            ? updateLeaf(s.root, existingPane.id, (leaf) => ({
                ...leaf,
                tabs: needsPin
                  ? leaf.tabs.map((t) =>
                      t.path === path ? { ...t, kind: 'pinned' as const } : t,
                    )
                  : leaf.tabs,
                activeId: activate ? path : leaf.activeId,
              }))
            : s.root;
        return {
          root: nextRoot,
          activePaneId: needsActivePane ? existingPane.id : s.activePaneId,
        };
      }
      // どこにも無いので活性ペインに新規で入れる。preview を置換 or 末尾追加
      const activePane = findLeafById(s.root, s.activePaneId);
      if (!activePane) return {};
      const newTab: Tab = { path, kind: opts?.pinned ? 'pinned' : 'preview', dirty: false };
      const preview = opts?.pinned ? null : findReplaceablePreview(activePane);
      const nextTabs = preview
        ? activePane.tabs.map((t) => (t.path === preview.path ? newTab : t))
        : [...activePane.tabs, newTab];
      const nextRoot = updateLeaf(s.root, activePane.id, (leaf) => ({
        ...leaf,
        tabs: nextTabs,
        activeId: activate ? path : (leaf.activeId ?? path),
      }));
      return { root: nextRoot };
    });
  },

  setActive: (path) => {
    set((s) => {
      const pane = findLeafByPath(s.root, path);
      if (!pane) return {};
      const nextRoot = updateLeaf(s.root, pane.id, (leaf) => ({ ...leaf, activeId: path }));
      return { root: nextRoot, activePaneId: pane.id };
    });
  },

  setActivePane: (paneId) => {
    set((s) => (findLeafById(s.root, paneId) ? { activePaneId: paneId } : {}));
  },

  promoteToPinned: (path) => {
    set((s) => {
      const pane = findLeafByPath(s.root, path);
      if (!pane) return {};
      const nextRoot = updateLeaf(s.root, pane.id, (leaf) => ({
        ...leaf,
        tabs: leaf.tabs.map((t) => (t.path === path ? { ...t, kind: 'pinned' as const } : t)),
      }));
      return { root: nextRoot };
    });
  },

  unpin: (path) => {
    set((s) => {
      const pane = findLeafByPath(s.root, path);
      if (!pane) return {};
      const nextRoot = updateLeaf(s.root, pane.id, (leaf) => ({
        ...leaf,
        tabs: leaf.tabs.map((t) => (t.path === path ? { ...t, kind: 'preview' as const } : t)),
      }));
      return { root: nextRoot };
    });
  },

  markDirty: (path, dirty) => {
    set((s) => {
      const pane = findLeafByPath(s.root, path);
      if (!pane) return {};
      const current = pane.tabs.find((t) => t.path === path)!;
      if (current.dirty === dirty && (!dirty || current.kind === 'pinned')) return {};
      const nextRoot = updateLeaf(s.root, pane.id, (leaf) => ({
        ...leaf,
        tabs: leaf.tabs.map((t) =>
          t.path === path
            ? { ...t, dirty, kind: dirty ? ('pinned' as const) : t.kind }
            : t,
        ),
      }));
      return { root: nextRoot };
    });
  },

  closeTab: (path) => {
    set((s) => {
      const pane = findLeafByPath(s.root, path);
      if (!pane) return {};
      const updated = removeTabFromPane(pane, path);
      const nextRoot0 = updateLeaf(s.root, pane.id, () => updated);
      const nextRoot = pruneEmpty(nextRoot0);
      // pending が閉じた path ならクリア
      const nextPending =
        s.pendingClose && s.pendingClose.path === path ? null : s.pendingClose;
      // 閉じた結果 activePane が消滅した場合(空 leaf 除去で pane.id が無くなった)は
      // 残っているどれかの leaf をアクティブに
      const activeStillExists = !!findLeafById(nextRoot, s.activePaneId);
      const nextActivePane = activeStillExists
        ? s.activePaneId
        : allLeaves(nextRoot)[0]?.id ?? s.activePaneId;
      return { root: nextRoot, pendingClose: nextPending, activePaneId: nextActivePane };
    });
  },

  closeOthers: (keepPath) => {
    set((s) => {
      const pane = findLeafByPath(s.root, keepPath);
      if (!pane) return {};
      const kept = pane.tabs.find((t) => t.path === keepPath)!;
      // pane 内の他タブを閉じる。他ペインは触らない(要件を最小に)
      const nextPane: LeafPane = { ...pane, tabs: [kept], activeId: keepPath };
      const nextRoot = updateLeaf(s.root, pane.id, () => nextPane);
      const nextPending =
        s.pendingClose && s.pendingClose.path === keepPath ? s.pendingClose : null;
      return { root: nextRoot, pendingClose: nextPending };
    });
  },

  closeToRight: (fromPath) => {
    set((s) => {
      const pane = findLeafByPath(s.root, fromPath);
      if (!pane) return {};
      const idx = pane.tabs.findIndex((t) => t.path === fromPath);
      const nextTabs = pane.tabs.slice(0, idx + 1);
      const activeStillOpen = nextTabs.some((t) => t.path === pane.activeId);
      const nextPane: LeafPane = {
        ...pane,
        tabs: nextTabs,
        activeId: activeStillOpen ? pane.activeId : fromPath,
      };
      const nextRoot = updateLeaf(s.root, pane.id, () => nextPane);
      const pendingStillOpen = s.pendingClose
        ? nextTabs.some((t) => t.path === s.pendingClose!.path)
        : false;
      return {
        root: nextRoot,
        pendingClose: pendingStillOpen ? s.pendingClose : null,
      };
    });
  },

  closeAll: () => {
    // レイアウトも単一 leaf に戻す
    set(() => initialState());
  },

  reorder: (path, toIndex) => {
    set((s) => {
      const pane = findLeafByPath(s.root, path);
      if (!pane) return {};
      const fromIndex = pane.tabs.findIndex((t) => t.path === path);
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        toIndex >= pane.tabs.length ||
        fromIndex === toIndex
      ) {
        return {};
      }
      const nextTabs = [...pane.tabs];
      const [moved] = nextTabs.splice(fromIndex, 1);
      nextTabs.splice(toIndex, 0, moved);
      const nextRoot = updateLeaf(s.root, pane.id, (leaf) => ({ ...leaf, tabs: nextTabs }));
      return { root: nextRoot };
    });
  },

  requestClose: (path) => {
    const pane = findLeafByPath(get().root, path);
    if (!pane) return;
    set({ pendingClose: { paneId: pane.id, path } });
  },
  cancelClose: () => set({ pendingClose: null }),

  splitOrMove: (sourcePath, targetPaneId, position) => {
    set((s) => {
      const sourcePane = findLeafByPath(s.root, sourcePath);
      if (!sourcePane) return {};
      const targetPane = findLeafById(s.root, targetPaneId);
      if (!targetPane) return {};

      const tab = sourcePane.tabs.find((t) => t.path === sourcePath)!;

      // center = 移動 or 同一ペインアクティブ切替
      if (position === 'center') {
        if (sourcePane.id === targetPaneId) {
          // 同一ペイン内は setActive 相当
          const nextRoot = updateLeaf(s.root, sourcePane.id, (leaf) => ({
            ...leaf,
            activeId: sourcePath,
          }));
          return { root: nextRoot, activePaneId: sourcePane.id };
        }
        // 別ペインへの移動: source から外し、target に追加
        const nextSource = removeTabFromPane(sourcePane, sourcePath);
        const nextTarget = addTabToPane(targetPane, tab, true);
        let nextRoot = updateLeaf(s.root, sourcePane.id, () => nextSource);
        nextRoot = updateLeaf(nextRoot, targetPane.id, () => nextTarget);
        nextRoot = pruneEmpty(nextRoot);
        return { root: nextRoot, activePaneId: targetPane.id };
      }

      // 分割: target を split ノードに置換する
      const dir: SplitDir = position === 'left' || position === 'right' ? 'row' : 'column';
      // 新規 leaf に source から取り外した tab を入れる
      const newLeaf: LeafPane = {
        kind: 'leaf',
        id: nextPaneId(),
        tabs: [tab],
        activeId: sourcePath,
      };

      // 分割時、target 側は自分自身をそのまま保持しつつ、source から tab を抜く
      const nextSource = removeTabFromPane(sourcePane, sourcePath);

      // まず source を更新
      let nextRoot = updateLeaf(s.root, sourcePane.id, () => nextSource);

      // target を split ノードに置き換える(target 自身は残す)
      // 左/上 → 新 leaf が a, 元 target が b
      // 右/下 → 元 target が a, 新 leaf が b
      const targetAfterUpdate = findLeafById(nextRoot, targetPane.id);
      if (!targetAfterUpdate) return {}; // 通常ありえない
      const split: SplitPane =
        position === 'left' || position === 'top'
          ? { kind: 'split', id: nextPaneId(), dir, a: newLeaf, b: targetAfterUpdate, ratio: 0.5 }
          : { kind: 'split', id: nextPaneId(), dir, a: targetAfterUpdate, b: newLeaf, ratio: 0.5 };

      nextRoot = replaceLeaf(nextRoot, targetPane.id, split);
      nextRoot = pruneEmpty(nextRoot);
      return { root: nextRoot, activePaneId: newLeaf.id };
    });
  },

  setPaneRatio: (splitId, ratio) => {
    const clamped = Math.max(0.1, Math.min(0.9, ratio));
    set((s) => ({ root: setRatioInTree(s.root, splitId, clamped) }));
  },

  reset: () => set(() => initialState()),
}));

function setRatioInTree(node: PaneNode, splitId: PaneId, ratio: number): PaneNode {
  if (node.kind === 'leaf') return node;
  if (node.id === splitId) return { ...node, ratio };
  return {
    ...node,
    a: setRatioInTree(node.a, splitId, ratio),
    b: setRatioInTree(node.b, splitId, ratio),
  };
}

// ------ 選択セレクタ(components/hooks から使う) ------

// 空タブ配列を返すセレクタが毎回新参照を返さないよう共有インスタンスを使う(Opus M1)。
// pane が消滅した瞬間の再レンダー抑制目的で、意図的に mutable フリーの空配列を再利用
const EMPTY_TABS: Tab[] = Object.freeze([]) as unknown as Tab[];

/** アクティブペインの tab リスト(旧 flat API の代替) */
export function useActivePaneTabs(): Tab[] {
  return useTabsStore((s) => {
    const pane = findLeafById(s.root, s.activePaneId);
    return pane?.tabs ?? EMPTY_TABS;
  });
}

export function useActivePaneActiveId(): string | null {
  return useTabsStore((s) => {
    const pane = findLeafById(s.root, s.activePaneId);
    return pane?.activeId ?? null;
  });
}

/** hooks の外(setState 前後や event handler)で使う。selectors と等価 */
export function getActivePaneActiveIdFromState(state: TabsState): string | null {
  const pane = findLeafById(state.root, state.activePaneId);
  return pane?.activeId ?? null;
}

export function getActivePaneTabsFromState(state: TabsState): Tab[] {
  const pane = findLeafById(state.root, state.activePaneId);
  return pane?.tabs ?? EMPTY_TABS;
}

/** レイアウトツリー(MainPage 描画用) */
export function useLayoutRoot(): PaneNode {
  return useTabsStore((s) => s.root);
}

/** ヘルパー: 全 leaf の全 tab の path 集合 */
export function useAllOpenPaths(): string[] {
  return useTabsStore((s) => allLeaves(s.root).flatMap((leaf) => leaf.tabs.map((t) => t.path)));
}

// テストや外部用途向けに素の関数も公開
export const _testHelpers = { findLeafByPath, findLeafById, allLeaves, pruneEmpty };
