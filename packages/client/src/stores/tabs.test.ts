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
});
