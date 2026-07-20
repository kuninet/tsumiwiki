import { beforeEach, describe, expect, it } from 'vitest';
import { _testHelpers, useTabsStore, type LeafPane, type PaneNode } from './tabs';

// tabs store のテスト。Phase B の木構造 API に対応。
// 「アクティブペイン」の内容は _testHelpers.findLeafById で取り出して検証する。

function activePane(): LeafPane {
  const s = useTabsStore.getState();
  const leaf = _testHelpers.findLeafById(s.root, s.activePaneId);
  if (!leaf) throw new Error('active pane not found');
  return leaf;
}

function activeTabs(): { path: string; kind: string; dirty: boolean }[] {
  return activePane().tabs.map((t) => ({ path: t.path, kind: t.kind, dirty: t.dirty }));
}

function activeActiveId(): string | null {
  return activePane().activeId;
}

// path で leaf を引く
function leafOf(path: string): LeafPane | null {
  return _testHelpers.findLeafByPath(useTabsStore.getState().root, path);
}

// 全ペインの全 tab
function allTabs(): { path: string; paneId: string }[] {
  return _testHelpers.allLeaves(useTabsStore.getState().root).flatMap((leaf) =>
    leaf.tabs.map((t) => ({ path: t.path, paneId: leaf.id })),
  );
}

describe('tabsストア', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
  });

  it('新規 openDoc は preview タブを作りアクティブにする', () => {
    useTabsStore.getState().openDoc('a.md');
    expect(activeTabs()).toEqual([{ path: 'a.md', kind: 'preview', dirty: false }]);
    expect(activeActiveId()).toBe('a.md');
  });

  it('preview 状態で別文書を開くと preview が置換されタブは増えない', () => {
    const { openDoc } = useTabsStore.getState();
    openDoc('a.md');
    openDoc('b.md');
    expect(activeTabs().map((t) => t.path)).toEqual(['b.md']);
    expect(activeActiveId()).toBe('b.md');
  });

  it('markDirty(true) は preview を pinned に昇格し、以降は上書きされない', () => {
    const { openDoc, markDirty } = useTabsStore.getState();
    openDoc('a.md');
    markDirty('a.md', true);
    openDoc('b.md');
    const tabs = activeTabs();
    expect(tabs.map((t) => t.path)).toEqual(['a.md', 'b.md']);
    expect(tabs[0]).toMatchObject({ kind: 'pinned', dirty: true });
    expect(tabs[1]).toMatchObject({ kind: 'preview', dirty: false });
  });

  it('promoteToPinned はプレビュータブを固定に昇格する', () => {
    const { openDoc, promoteToPinned } = useTabsStore.getState();
    openDoc('a.md');
    promoteToPinned('a.md');
    openDoc('b.md');
    const tabs = activeTabs();
    expect(tabs).toHaveLength(2);
    expect(tabs[0].kind).toBe('pinned');
    expect(tabs[1].kind).toBe('preview');
  });

  it('同じ path を再度 openDoc してもタブは増えず kind は保持される', () => {
    const { openDoc, promoteToPinned } = useTabsStore.getState();
    openDoc('a.md');
    promoteToPinned('a.md');
    openDoc('b.md');
    openDoc('a.md');
    const tabs = activeTabs();
    expect(tabs).toHaveLength(2);
    expect(activeActiveId()).toBe('a.md');
    expect(tabs.find((t) => t.path === 'a.md')?.kind).toBe('pinned');
    expect(tabs.find((t) => t.path === 'b.md')?.kind).toBe('preview');
  });

  it('opts.pinned=true で開くと preview を置換せず新規 pinned として追加される', () => {
    const { openDoc } = useTabsStore.getState();
    openDoc('a.md');
    openDoc('b.md', { pinned: true });
    const tabs = activeTabs();
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t) => t.path === 'a.md')?.kind).toBe('preview');
    expect(tabs.find((t) => t.path === 'b.md')?.kind).toBe('pinned');
  });

  it('markDirty(false) は dirty を落とすが kind は pinned のまま', () => {
    const { openDoc, markDirty } = useTabsStore.getState();
    openDoc('a.md');
    markDirty('a.md', true);
    markDirty('a.md', false);
    expect(activeTabs()[0]).toMatchObject({ kind: 'pinned', dirty: false });
  });

  it('setActive は存在しないタブでは何もしない', () => {
    const { openDoc, setActive } = useTabsStore.getState();
    openDoc('a.md');
    setActive('missing.md');
    expect(activeActiveId()).toBe('a.md');
  });

  describe('closeTab', () => {
    it('タブを閉じる。アクティブが閉じられた場合は隣(右優先)へ移動する', () => {
      const { openDoc, closeTab, setActive } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      openDoc('c.md', { pinned: true });
      setActive('b.md');
      closeTab('b.md');
      expect(activeTabs().map((t) => t.path)).toEqual(['a.md', 'c.md']);
      expect(activeActiveId()).toBe('c.md');
    });

    it('末尾のアクティブタブを閉じた場合は左の末尾にフォールバックする', () => {
      const { openDoc, closeTab, setActive } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      setActive('b.md');
      closeTab('b.md');
      expect(activeActiveId()).toBe('a.md');
    });

    it('最後の1タブを閉じたら activeId は null', () => {
      const { openDoc, closeTab } = useTabsStore.getState();
      openDoc('a.md');
      closeTab('a.md');
      expect(activeTabs()).toEqual([]);
      expect(activeActiveId()).toBeNull();
    });

    it('非アクティブなタブを閉じても activeId は変わらない', () => {
      const { openDoc, closeTab, setActive } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      setActive('b.md');
      closeTab('a.md');
      expect(activeActiveId()).toBe('b.md');
    });

    it('存在しないタブは無視する', () => {
      const { openDoc, closeTab } = useTabsStore.getState();
      openDoc('a.md');
      closeTab('missing.md');
      expect(activeTabs()).toHaveLength(1);
    });
  });

  describe('closeOthers', () => {
    it('指定 path 以外を全て閉じ、指定タブがアクティブになる', () => {
      const { openDoc, closeOthers } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      openDoc('c.md', { pinned: true });
      closeOthers('b.md');
      expect(activeTabs().map((t) => t.path)).toEqual(['b.md']);
      expect(activeActiveId()).toBe('b.md');
    });
  });

  describe('closeToRight', () => {
    it('指定 path の右側を閉じる。アクティブが右側にあれば指定タブへ移動する', () => {
      const { openDoc, closeToRight, setActive } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      openDoc('c.md', { pinned: true });
      setActive('c.md');
      closeToRight('a.md');
      expect(activeTabs().map((t) => t.path)).toEqual(['a.md']);
      expect(activeActiveId()).toBe('a.md');
    });

    it('アクティブが左側なら activeId は変わらない', () => {
      const { openDoc, closeToRight, setActive } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      openDoc('c.md', { pinned: true });
      setActive('a.md');
      closeToRight('b.md');
      expect(activeTabs().map((t) => t.path)).toEqual(['a.md', 'b.md']);
      expect(activeActiveId()).toBe('a.md');
    });
  });

  describe('closeAll', () => {
    it('全て閉じてレイアウトも単一 leaf に戻す', () => {
      const { openDoc, closeAll, splitOrMove } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      // 分割してから closeAll
      const paneId = useTabsStore.getState().activePaneId;
      splitOrMove('a.md', paneId, 'right');
      closeAll();
      const s = useTabsStore.getState();
      expect(s.root.kind).toBe('leaf');
      expect((s.root as LeafPane).tabs).toEqual([]);
      expect(s.activePaneId).toBe((s.root as LeafPane).id);
    });
  });

  describe('unpin', () => {
    it('pinned を preview に戻す', () => {
      const { openDoc, promoteToPinned, unpin } = useTabsStore.getState();
      openDoc('a.md');
      promoteToPinned('a.md');
      unpin('a.md');
      expect(activeTabs()[0].kind).toBe('preview');
    });
  });

  describe('pendingClose のクリア', () => {
    it('closeTab で対象タブが閉じたら pendingClose もクリア', () => {
      const { openDoc, requestClose, closeTab } = useTabsStore.getState();
      openDoc('a.md');
      requestClose('a.md');
      closeTab('a.md');
      expect(useTabsStore.getState().pendingClose).toBeNull();
    });

    it('closeOthers で pending 対象が閉じたらクリア、残されたら維持', () => {
      const { openDoc, requestClose, closeOthers } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      requestClose('a.md');
      closeOthers('b.md');
      expect(useTabsStore.getState().pendingClose).toBeNull();

      useTabsStore.getState().reset();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      requestClose('a.md');
      closeOthers('a.md');
      expect(useTabsStore.getState().pendingClose?.path).toBe('a.md');
    });

    it('closeAll で pending はクリア', () => {
      const { openDoc, requestClose, closeAll } = useTabsStore.getState();
      openDoc('a.md');
      requestClose('a.md');
      closeAll();
      expect(useTabsStore.getState().pendingClose).toBeNull();
    });
  });

  describe('reorder', () => {
    it('タブ位置を入れ替える', () => {
      const { openDoc, reorder } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      openDoc('c.md', { pinned: true });
      reorder('a.md', 2);
      expect(activeTabs().map((t) => t.path)).toEqual(['b.md', 'c.md', 'a.md']);
    });

    it('範囲外/同一 index は無視', () => {
      const { openDoc, reorder } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      reorder('a.md', 5);
      reorder('a.md', 0);
      expect(activeTabs().map((t) => t.path)).toEqual(['a.md', 'b.md']);
    });
  });

  // Phase B: 分割ペイン
  describe('splitOrMove', () => {
    it('right ドロップで縦2分割になり、新 leaf に対象タブが移る', () => {
      const { openDoc, splitOrMove } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      const sourcePaneId = useTabsStore.getState().activePaneId;
      splitOrMove('a.md', sourcePaneId, 'right');
      const s = useTabsStore.getState();
      expect(s.root.kind).toBe('split');
      if (s.root.kind !== 'split') throw new Error();
      expect(s.root.dir).toBe('row');
      // 元 pane が a、新 leaf が b
      expect(s.root.a.kind).toBe('leaf');
      expect(s.root.b.kind).toBe('leaf');
      if (s.root.a.kind !== 'leaf' || s.root.b.kind !== 'leaf') throw new Error();
      expect(s.root.a.tabs.map((t) => t.path)).toEqual(['b.md']);
      expect(s.root.b.tabs.map((t) => t.path)).toEqual(['a.md']);
      // 新 leaf がアクティブペイン
      expect(s.activePaneId).toBe(s.root.b.id);
    });

    it('bottom ドロップで横2分割(dir=column)、position=left なら新 leaf が a', () => {
      const { openDoc, splitOrMove } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      const sourcePaneId = useTabsStore.getState().activePaneId;
      splitOrMove('a.md', sourcePaneId, 'left');
      const s = useTabsStore.getState();
      if (s.root.kind !== 'split') throw new Error();
      expect(s.root.dir).toBe('row');
      // left → 新 leaf が a
      if (s.root.a.kind !== 'leaf' || s.root.b.kind !== 'leaf') throw new Error();
      expect(s.root.a.tabs.map((t) => t.path)).toEqual(['a.md']);
      expect(s.root.b.tabs.map((t) => t.path)).toEqual(['b.md']);
    });

    it('center ドロップ(別ペイン)はタブを対象ペインへ移動する', () => {
      const { openDoc, splitOrMove } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      // まず a を右に分割
      splitOrMove('a.md', useTabsStore.getState().activePaneId, 'right');
      // 元 pane に残った b を、a.md のペインへ center 移動
      const s1 = useTabsStore.getState();
      if (s1.root.kind !== 'split' || s1.root.b.kind !== 'leaf') throw new Error();
      const targetPaneId = s1.root.b.id; // a.md がいる方
      splitOrMove('b.md', targetPaneId, 'center');
      // すべてのタブが 1 ペインに集まって、空 pane は prune される想定
      const s2 = useTabsStore.getState();
      expect(s2.root.kind).toBe('leaf');
      if (s2.root.kind !== 'leaf') throw new Error();
      expect(s2.root.tabs.map((t) => t.path).sort()).toEqual(['a.md', 'b.md']);
    });

    it('分割後にタブを全部閉じたペインは prune される(単一 leaf に戻る)', () => {
      const { openDoc, splitOrMove, closeTab } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      splitOrMove('a.md', useTabsStore.getState().activePaneId, 'right');
      // 分割後 a.md を閉じると新 leaf が空になり、split ノードが消える
      closeTab('a.md');
      const s = useTabsStore.getState();
      expect(s.root.kind).toBe('leaf');
      if (s.root.kind !== 'leaf') throw new Error();
      expect(s.root.tabs.map((t) => t.path)).toEqual(['b.md']);
    });
  });

  describe('setPaneRatio', () => {
    it('分割の比率を更新する。範囲は 0.1〜0.9 にクランプ', () => {
      const { openDoc, splitOrMove, setPaneRatio } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      splitOrMove('a.md', useTabsStore.getState().activePaneId, 'right');
      const s1 = useTabsStore.getState();
      if (s1.root.kind !== 'split') throw new Error();
      const splitId = s1.root.id;
      setPaneRatio(splitId, 0.7);
      const s2 = useTabsStore.getState();
      if (s2.root.kind !== 'split') throw new Error();
      expect(s2.root.ratio).toBe(0.7);
      setPaneRatio(splitId, 0.05);
      expect((useTabsStore.getState().root as PaneNode & { ratio: number }).ratio).toBe(0.1);
      setPaneRatio(splitId, 1.5);
      expect((useTabsStore.getState().root as PaneNode & { ratio: number }).ratio).toBe(0.9);
    });
  });

  describe('setActive をまたぐペイン移動', () => {
    it('別ペインの path を setActive すると activePaneId も切り替わる', () => {
      const { openDoc, splitOrMove, setActive } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      splitOrMove('a.md', useTabsStore.getState().activePaneId, 'right');
      // 今アクティブは a.md の新 leaf
      // b.md(元 pane)を setActive
      setActive('b.md');
      const s = useTabsStore.getState();
      const bLeaf = leafOf('b.md');
      expect(s.activePaneId).toBe(bLeaf?.id);
    });
  });

  it('allTabs で複数ペインの tab が拾える', () => {
    const { openDoc, splitOrMove } = useTabsStore.getState();
    openDoc('a.md', { pinned: true });
    openDoc('b.md', { pinned: true });
    splitOrMove('a.md', useTabsStore.getState().activePaneId, 'right');
    expect(allTabs().map((t) => t.path).sort()).toEqual(['a.md', 'b.md']);
  });
});
