import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabsStore, type PaneNode } from '../stores/tabs';
import { PaneLayout } from './PaneLayout';

// PaneLayout の再帰レンダー: leaf → PaneView, split → row/column に子ノード + Resizer
// 実際の DocTab は API 呼び出しが多いのでスタブ fetch で必要な最低限のみ返す

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ user: null }) }),
    ),
  );
}

function renderWith(node: PaneNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PaneLayout node={node} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PaneLayout', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('leaf ノードを PaneView として描画する', () => {
    // reset 後、活性ペインとして 1 leaf が生成される。それを直接渡す
    useTabsStore.getState().openDoc('a.md', { pinned: true });
    const root = useTabsStore.getState().root;
    renderWith(root);
    // PaneView の data-testid=pane-<id> が現れる
    if (root.kind !== 'leaf') throw new Error('expected leaf root');
    expect(screen.getByTestId(`pane-${root.id}`)).toBeTruthy();
  });

  it('split ノードは flex-row / flex-col を dir で切り替え、Resizer を挟む', () => {
    // 分割状態を作る
    useTabsStore.getState().openDoc('a.md', { pinned: true });
    useTabsStore.getState().openDoc('b.md', { pinned: true });
    useTabsStore.getState().splitOrMove('a.md', useTabsStore.getState().activePaneId, 'right');
    const root = useTabsStore.getState().root;
    if (root.kind !== 'split') throw new Error('expected split root');

    renderWith(root);
    // Resizer が存在
    expect(screen.getByTestId(`resizer-${root.id}`)).toBeTruthy();
    // split コンテナに data-split-id が付与
    const split = screen.getByTestId(`split-${root.id}`);
    expect(split.className).toMatch(/flex-row/);

    // 上下分割で確認
    useTabsStore.getState().reset();
    useTabsStore.getState().openDoc('a.md', { pinned: true });
    useTabsStore.getState().openDoc('b.md', { pinned: true });
    useTabsStore.getState().splitOrMove('a.md', useTabsStore.getState().activePaneId, 'top');
    const root2 = useTabsStore.getState().root;
    if (root2.kind !== 'split') throw new Error();
    cleanup();
    renderWith(root2);
    expect(screen.getByTestId(`split-${root2.id}`).className).toMatch(/flex-col/);
  });
});
