import { beforeEach, describe, expect, it } from 'vitest';
import { useTabsStore } from './tabs';

describe('tabsストア', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
  });

  it('新規 openDoc は preview タブを作りアクティブにする', () => {
    useTabsStore.getState().openDoc('a.md');
    const s = useTabsStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({ path: 'a.md', kind: 'preview', dirty: false });
    expect(s.activeId).toBe('a.md');
  });

  it('preview 状態で別文書を開くと preview が置換されタブは増えない', () => {
    const { openDoc } = useTabsStore.getState();
    openDoc('a.md');
    openDoc('b.md');
    const s = useTabsStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].path).toBe('b.md');
    expect(s.activeId).toBe('b.md');
  });

  it('markDirty(true) は preview を pinned に昇格し、以降は上書きされない', () => {
    const { openDoc, markDirty } = useTabsStore.getState();
    openDoc('a.md');
    markDirty('a.md', true);
    openDoc('b.md');
    const s = useTabsStore.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs.map((t) => t.path)).toEqual(['a.md', 'b.md']);
    expect(s.tabs[0]).toMatchObject({ kind: 'pinned', dirty: true });
    expect(s.tabs[1]).toMatchObject({ kind: 'preview', dirty: false });
  });

  it('promoteToPinned はプレビュータブを固定に昇格する', () => {
    const { openDoc, promoteToPinned } = useTabsStore.getState();
    openDoc('a.md');
    promoteToPinned('a.md');
    openDoc('b.md');
    const s = useTabsStore.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs[0].kind).toBe('pinned');
    expect(s.tabs[1].kind).toBe('preview');
  });

  it('同じ path を再度 openDoc してもタブは増えず kind は保持される', () => {
    const { openDoc, promoteToPinned } = useTabsStore.getState();
    openDoc('a.md');
    promoteToPinned('a.md');
    openDoc('b.md'); // preview
    openDoc('a.md'); // 既存 pinned タブへアクティブ切替のみ
    const s = useTabsStore.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.activeId).toBe('a.md');
    expect(s.tabs.find((t) => t.path === 'a.md')?.kind).toBe('pinned');
    expect(s.tabs.find((t) => t.path === 'b.md')?.kind).toBe('preview');
  });

  it('opts.pinned=true で開くと preview を置換せず新規 pinned として追加される', () => {
    const { openDoc } = useTabsStore.getState();
    openDoc('a.md'); // preview
    openDoc('b.md', { pinned: true });
    const s = useTabsStore.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs.find((t) => t.path === 'a.md')?.kind).toBe('preview');
    expect(s.tabs.find((t) => t.path === 'b.md')?.kind).toBe('pinned');
  });

  it('markDirty(false) は dirty を落とすが kind は pinned のまま', () => {
    const { openDoc, markDirty } = useTabsStore.getState();
    openDoc('a.md');
    markDirty('a.md', true);
    markDirty('a.md', false);
    const s = useTabsStore.getState();
    expect(s.tabs[0]).toMatchObject({ kind: 'pinned', dirty: false });
  });

  it('setActive は存在しないタブでは何もしない', () => {
    const { openDoc, setActive } = useTabsStore.getState();
    openDoc('a.md');
    setActive('missing.md');
    expect(useTabsStore.getState().activeId).toBe('a.md');
  });

  // Phase A-2: closeTab / closeOthers / closeToRight / closeAll / unpin / reorder
  describe('closeTab', () => {
    it('タブを閉じる。アクティブが閉じられた場合は隣(右優先)へ移動する', () => {
      const { openDoc, closeTab } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      openDoc('c.md', { pinned: true });
      useTabsStore.getState().setActive('b.md');
      closeTab('b.md');
      const s = useTabsStore.getState();
      expect(s.tabs.map((t) => t.path)).toEqual(['a.md', 'c.md']);
      // 元 b の位置(index=1)にあった c が新アクティブ
      expect(s.activeId).toBe('c.md');
    });

    it('末尾のアクティブタブを閉じた場合は左の末尾にフォールバックする', () => {
      const { openDoc, closeTab } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      useTabsStore.getState().setActive('b.md');
      closeTab('b.md');
      expect(useTabsStore.getState().activeId).toBe('a.md');
    });

    it('最後の1タブを閉じたら activeId は null', () => {
      const { openDoc, closeTab } = useTabsStore.getState();
      openDoc('a.md');
      closeTab('a.md');
      const s = useTabsStore.getState();
      expect(s.tabs).toEqual([]);
      expect(s.activeId).toBeNull();
    });

    it('非アクティブなタブを閉じても activeId は変わらない', () => {
      const { openDoc, closeTab, setActive } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      setActive('b.md');
      closeTab('a.md');
      expect(useTabsStore.getState().activeId).toBe('b.md');
    });

    it('存在しないタブは無視する', () => {
      const { openDoc, closeTab } = useTabsStore.getState();
      openDoc('a.md');
      closeTab('missing.md');
      expect(useTabsStore.getState().tabs).toHaveLength(1);
    });
  });

  describe('closeOthers', () => {
    it('指定 path 以外を全て閉じ、指定タブがアクティブになる', () => {
      const { openDoc, closeOthers } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      openDoc('c.md', { pinned: true });
      closeOthers('b.md');
      const s = useTabsStore.getState();
      expect(s.tabs.map((t) => t.path)).toEqual(['b.md']);
      expect(s.activeId).toBe('b.md');
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
      const s = useTabsStore.getState();
      expect(s.tabs.map((t) => t.path)).toEqual(['a.md']);
      expect(s.activeId).toBe('a.md');
    });

    it('アクティブが左側なら activeId は変わらない', () => {
      const { openDoc, closeToRight } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      openDoc('c.md', { pinned: true });
      useTabsStore.getState().setActive('a.md');
      closeToRight('b.md');
      const s = useTabsStore.getState();
      expect(s.tabs.map((t) => t.path)).toEqual(['a.md', 'b.md']);
      expect(s.activeId).toBe('a.md');
    });
  });

  describe('closeAll', () => {
    it('全て閉じる', () => {
      const { openDoc, closeAll } = useTabsStore.getState();
      openDoc('a.md');
      openDoc('b.md', { pinned: true });
      closeAll();
      const s = useTabsStore.getState();
      expect(s.tabs).toEqual([]);
      expect(s.activeId).toBeNull();
    });
  });

  describe('unpin', () => {
    it('pinned を preview に戻す', () => {
      const { openDoc, promoteToPinned, unpin } = useTabsStore.getState();
      openDoc('a.md');
      promoteToPinned('a.md');
      unpin('a.md');
      expect(useTabsStore.getState().tabs[0].kind).toBe('preview');
    });
  });

  describe('pendingCloseId のクリア', () => {
    it('closeTab で対象タブが閉じたら pendingCloseId もクリア', () => {
      const { openDoc, requestClose, closeTab } = useTabsStore.getState();
      openDoc('a.md');
      requestClose('a.md');
      closeTab('a.md');
      expect(useTabsStore.getState().pendingCloseId).toBeNull();
    });

    it('closeOthers で pending 対象が閉じたらクリア、残されたら維持', () => {
      const { openDoc, requestClose, closeOthers } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      requestClose('a.md');
      closeOthers('b.md');
      expect(useTabsStore.getState().pendingCloseId).toBeNull();

      useTabsStore.getState().reset();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      requestClose('a.md');
      closeOthers('a.md');
      expect(useTabsStore.getState().pendingCloseId).toBe('a.md');
    });

    it('closeToRight で pending が閉じたらクリア', () => {
      const { openDoc, requestClose, closeToRight } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      requestClose('b.md');
      closeToRight('a.md');
      expect(useTabsStore.getState().pendingCloseId).toBeNull();
    });

    it('closeAll で pending はクリア', () => {
      const { openDoc, requestClose, closeAll } = useTabsStore.getState();
      openDoc('a.md');
      requestClose('a.md');
      closeAll();
      expect(useTabsStore.getState().pendingCloseId).toBeNull();
    });
  });

  describe('reorder', () => {
    it('タブ位置を入れ替える', () => {
      const { openDoc, reorder } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      openDoc('c.md', { pinned: true });
      reorder(0, 2);
      expect(useTabsStore.getState().tabs.map((t) => t.path)).toEqual(['b.md', 'c.md', 'a.md']);
    });

    it('範囲外/同一 index は無視', () => {
      const { openDoc, reorder } = useTabsStore.getState();
      openDoc('a.md', { pinned: true });
      openDoc('b.md', { pinned: true });
      reorder(5, 0);
      reorder(0, 0);
      expect(useTabsStore.getState().tabs.map((t) => t.path)).toEqual(['a.md', 'b.md']);
    });
  });
});
