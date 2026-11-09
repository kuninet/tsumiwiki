import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import type { TreeResponse } from '@tsumiwiki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TREE_QUERY_KEY } from '../api/docs';
import { useUIStore } from '../stores/ui';
import {
  type FollowActiveDocInTreeOptions,
  useFollowActiveDocInTree,
} from './use-follow-active-doc-in-tree';

const DEEP_TREE: TreeResponse = {
  folders: ['A', 'A/B', 'A/B/C', 'X'],
  docs: [
    { path: 'A/B/C/深い.md', title: '深い', folder: 'A/B/C', updatedAt: 't' },
    { path: 'X/別.md', title: '別', folder: 'X', updatedAt: 't' },
    { path: 'ルート.md', title: 'ルート', folder: '', updatedAt: 't' },
  ],
};

let nav: (path: string, options?: { replace?: boolean }) => void;

function NavProbe() {
  const navigate = useNavigate();
  nav = navigate;
  return <div>probe</div>;
}

function Layout({ options }: { options?: FollowActiveDocInTreeOptions }) {
  useFollowActiveDocInTree(options);
  return <Outlet />;
}

function setup(
  initialPath = '/',
  tree: TreeResponse | Promise<TreeResponse> = DEEP_TREE,
  options?: FollowActiveDocInTreeOptions,
) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/tree') {
      if (tree instanceof Promise) {
        return tree.then((data) => ({
          ok: true,
          status: 200,
          json: () => Promise.resolve(data),
        }));
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tree),
      });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<Layout options={options} />}>
            <Route path="/" element={<NavProbe />} />
            <Route path="doc/*" element={<NavProbe />} />
            <Route path="history/*" element={<NavProbe />} />
            <Route path="settings" element={<NavProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return { ...utils, queryClient, fetchMock };
}

describe('useFollowActiveDocInTree (#323)', () => {
  beforeEach(() => {
    useUIStore.setState({
      expandedFolders: new Set(),
      revealRequest: null,
      sidebarTab: 'folder',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    useUIStore.setState({
      expandedFolders: new Set(),
      revealRequest: null,
      sidebarTab: 'folder',
    });
  });

  it('H-1: URL /doc/A/B/C/深い.md で tree 取得完了後に祖先フォルダが展開され revealRequest が積まれる', async () => {
    setup('/doc/A/B/C/深い.md');
    await waitFor(() => {
      expect(useUIStore.getState().expandedFolders.has('A')).toBe(true);
      expect(useUIStore.getState().expandedFolders.has('A/B')).toBe(true);
      expect(useUIStore.getState().expandedFolders.has('A/B/C')).toBe(true);
      expect(useUIStore.getState().revealRequest?.path).toBe('A/B/C/深い.md');
    });
  });

  it('H-2: tree 応答保留中は追従せず、resolve 後に追従する', async () => {
    let resolveTree!: (value: TreeResponse) => void;
    const treePromise = new Promise<TreeResponse>((resolve) => {
      resolveTree = resolve;
    });
    setup('/doc/A/B/C/深い.md', treePromise);

    expect(useUIStore.getState().expandedFolders.size).toBe(0);
    expect(useUIStore.getState().revealRequest).toBeNull();

    await act(async () => {
      resolveTree(DEEP_TREE);
    });

    await waitFor(() => {
      expect(useUIStore.getState().expandedFolders.has('A/B/C')).toBe(true);
      expect(useUIStore.getState().revealRequest?.path).toBe('A/B/C/深い.md');
    });
  });

  it('H-3: 手動で閉じたフォルダは tree の再取得(invalidate)でも開き直さない', async () => {
    const { queryClient } = setup('/doc/A/B/C/深い.md');
    await waitFor(() => {
      expect(useUIStore.getState().revealRequest?.path).toBe('A/B/C/深い.md');
    });
    useUIStore.getState().consumeRevealRequest(useUIStore.getState().revealRequest!.nonce);
    expect(useUIStore.getState().revealRequest).toBeNull();

    act(() => {
      useUIStore.getState().toggleFolderExpanded('A/B');
    });
    expect(useUIStore.getState().expandedFolders.has('A/B')).toBe(false);

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
    });

    expect(useUIStore.getState().expandedFolders.has('A/B')).toBe(false);
    expect(useUIStore.getState().revealRequest).toBeNull();
  });

  it('H-4: 別の文書に navigate するとその祖先が展開され、閉じられた無関係なフォルダは維持される', async () => {
    setup('/doc/A/B/C/深い.md');
    await waitFor(() => {
      expect(useUIStore.getState().revealRequest?.path).toBe('A/B/C/深い.md');
    });
    act(() => {
      useUIStore.getState().toggleFolderExpanded('A/B');
    });
    expect(useUIStore.getState().expandedFolders.has('A/B')).toBe(false);

    act(() => {
      nav('/doc/X/別.md');
    });

    await waitFor(() => {
      expect(useUIStore.getState().expandedFolders.has('X')).toBe(true);
      expect(useUIStore.getState().expandedFolders.has('A/B')).toBe(false);
      expect(useUIStore.getState().revealRequest?.path).toBe('X/別.md');
    });
  });

  it('H-5: 以前開いていた文書に戻ると再び追従して閉じたフォルダも再展開される', async () => {
    setup('/doc/A/B/C/深い.md');
    await waitFor(() => {
      expect(useUIStore.getState().revealRequest?.path).toBe('A/B/C/深い.md');
    });
    act(() => {
      useUIStore.getState().toggleFolderExpanded('A/B');
    });
    expect(useUIStore.getState().expandedFolders.has('A/B')).toBe(false);

    act(() => {
      nav('/doc/X/別.md');
    });
    await waitFor(() => {
      expect(useUIStore.getState().revealRequest?.path).toBe('X/別.md');
    });

    act(() => {
      nav('/doc/A/B/C/深い.md');
    });
    await waitFor(() => {
      expect(useUIStore.getState().expandedFolders.has('A/B')).toBe(true);
      expect(useUIStore.getState().revealRequest?.path).toBe('A/B/C/深い.md');
    });
  });

  it('H-6: enabled: false の場合、tree があっても追従しない', async () => {
    setup('/doc/A/B/C/深い.md', DEEP_TREE, { enabled: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(useUIStore.getState().expandedFolders.size).toBe(0);
    expect(useUIStore.getState().revealRequest).toBeNull();
  });

  it('H-7: tree に存在しない文書パスの場合追従しない', async () => {
    setup('/doc/A/B/C/存在しない.md');
    await new Promise((r) => setTimeout(r, 50));
    expect(useUIStore.getState().expandedFolders.size).toBe(0);
    expect(useUIStore.getState().revealRequest).toBeNull();
  });

  it('H-8: tree に文書が追加されて invalidate された時点で追従する', async () => {
    let currentTree = DEEP_TREE;
    const { queryClient, fetchMock } = setup('/doc/A/B/C/存在しない.md');
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(useUIStore.getState().expandedFolders.size).toBe(0);

    currentTree = {
      ...DEEP_TREE,
      docs: [
        ...DEEP_TREE.docs,
        { path: 'A/B/C/存在しない.md', title: '存在しない', folder: 'A/B/C', updatedAt: 't' },
      ],
    };
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/tree') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(currentTree) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
    });

    await waitFor(() => {
      expect(useUIStore.getState().expandedFolders.has('A/B/C')).toBe(true);
      expect(useUIStore.getState().revealRequest?.path).toBe('A/B/C/存在しない.md');
    });
  });

  it('H-9: .md なしのパスでは追従せず、.md 付きに navigate されると追従する', async () => {
    setup('/doc/A/B/C/深い');
    await new Promise((r) => setTimeout(r, 50));
    expect(useUIStore.getState().expandedFolders.size).toBe(0);
    expect(useUIStore.getState().revealRequest).toBeNull();

    act(() => {
      nav('/doc/A/B/C/深い.md', { replace: true });
    });

    await waitFor(() => {
      expect(useUIStore.getState().expandedFolders.has('A/B/C')).toBe(true);
      expect(useUIStore.getState().revealRequest?.path).toBe('A/B/C/深い.md');
    });
  });

  it('H-10: URL /history/A/B/C/深い.md でも同様に追従する', async () => {
    setup('/history/A/B/C/深い.md');
    await waitFor(() => {
      expect(useUIStore.getState().expandedFolders.has('A/B/C')).toBe(true);
      expect(useUIStore.getState().revealRequest?.path).toBe('A/B/C/深い.md');
    });
  });

  it('H-11: 文書を開いていない画面(/settings)を挟むと、同じ文書に戻ったときに再追従する', async () => {
    setup('/doc/A/B/C/深い.md');
    await waitFor(() => {
      expect(useUIStore.getState().revealRequest?.path).toBe('A/B/C/深い.md');
    });
    act(() => {
      useUIStore.getState().toggleFolderExpanded('A/B');
    });
    expect(useUIStore.getState().expandedFolders.has('A/B')).toBe(false);

    act(() => {
      nav('/settings');
    });
    act(() => {
      nav('/doc/A/B/C/深い.md');
    });

    await waitFor(() => {
      expect(useUIStore.getState().expandedFolders.has('A/B')).toBe(true);
      expect(useUIStore.getState().revealRequest?.path).toBe('A/B/C/深い.md');
    });
  });

  it('H-12: enabled: false から enabled: true に rerender されると追従する', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(DEEP_TREE) }),
    );

    function TestApp({ enabled }: { enabled: boolean }) {
      return (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/doc/A/B/C/深い.md']}>
            <Routes>
              <Route element={<Layout options={{ enabled }} />}>
                <Route path="doc/*" element={<NavProbe />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );
    }

    const { rerender } = render(<TestApp enabled={false} />);

    await new Promise((r) => setTimeout(r, 50));
    expect(useUIStore.getState().expandedFolders.size).toBe(0);

    rerender(<TestApp enabled={true} />);

    await waitFor(() => {
      expect(useUIStore.getState().expandedFolders.has('A/B/C')).toBe(true);
      expect(useUIStore.getState().revealRequest?.path).toBe('A/B/C/深い.md');
    });
  });
});
