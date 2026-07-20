import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllOpenPathsFromState, useTabsStore } from '../stores/tabs';
import { useToastStore } from '../stores/toast';
import { useTabsBootCleanup } from './use-tabs-boot-cleanup';

function stubFetch(treeDocs: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            docs: treeDocs.map((p) => ({ path: p, title: p, folder: '', updatedAt: '' })),
          }),
      }),
    ),
  );
}

function Probe() {
  useTabsBootCleanup();
  return null;
}

function render_() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
}

describe('useTabsBootCleanup', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useToastStore.setState({ toast: null });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('tree に含まれない path のタブを閉じる + トースト', async () => {
    useTabsStore.getState().openDoc('exists.md', { pinned: true });
    useTabsStore.getState().openDoc('deleted.md', { pinned: true });
    stubFetch(['exists.md']);
    render_();
    await waitFor(() => {
      expect(getAllOpenPathsFromState(useTabsStore.getState())).toEqual(['exists.md']);
    });
    expect(useToastStore.getState().toast).toMatchObject({ kind: 'info' });
  });

  it('全タブが tree に存在するなら何もしない(トーストも出ない)', async () => {
    useTabsStore.getState().openDoc('a.md', { pinned: true });
    useTabsStore.getState().openDoc('b.md', { pinned: true });
    stubFetch(['a.md', 'b.md']);
    render_();
    // 少し待ってから状態確認
    await new Promise((r) => setTimeout(r, 20));
    expect(getAllOpenPathsFromState(useTabsStore.getState()).sort()).toEqual(['a.md', 'b.md']);
    expect(useToastStore.getState().toast).toBeNull();
  });

  it('タブが空なら何もしない', async () => {
    stubFetch(['a.md']);
    render_();
    await new Promise((r) => setTimeout(r, 20));
    expect(useToastStore.getState().toast).toBeNull();
  });
});
