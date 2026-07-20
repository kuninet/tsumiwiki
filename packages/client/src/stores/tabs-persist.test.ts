import { beforeEach, describe, expect, it } from 'vitest';
import { _testHelpers, useTabsStore, type PaneNode } from './tabs';

// Phase D(#139): 永続化と復元の周辺
// - bumpPaneCounter: 復元後の paneCounter を既存 ID の最大値まで持ち上げる

describe('bumpPaneCounter', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
  });

  it('leaf のみのツリー', () => {
    const root: PaneNode = { kind: 'leaf', id: 'p3', tabs: [], activeId: null };
    _testHelpers.bumpPaneCounter(root);
    expect(_testHelpers.getPaneCounter()).toBe(3);
  });

  it('split 入りネストで最大 ID を拾う', () => {
    const root: PaneNode = {
      kind: 'split',
      id: 'p5',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', id: 'p2', tabs: [], activeId: null },
      b: {
        kind: 'split',
        id: 'p7',
        dir: 'column',
        ratio: 0.4,
        a: { kind: 'leaf', id: 'p10', tabs: [], activeId: null },
        b: { kind: 'leaf', id: 'p1', tabs: [], activeId: null },
      },
    };
    _testHelpers.bumpPaneCounter(root);
    expect(_testHelpers.getPaneCounter()).toBe(10);
  });

  it('未知の ID 形式は無視', () => {
    const root: PaneNode = { kind: 'leaf', id: 'custom-id', tabs: [], activeId: null };
    _testHelpers.bumpPaneCounter(root);
    expect(_testHelpers.getPaneCounter()).toBe(0);
  });
});
