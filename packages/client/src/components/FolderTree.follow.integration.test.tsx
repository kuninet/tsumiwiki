import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import type { TreeResponse } from '@tsumiwiki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TREE_QUERY_KEY } from '../api/docs';
import { useFollowActiveDocInTree } from '../hooks/use-follow-active-doc-in-tree';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { useUIStore } from '../stores/ui';
import { FolderTree } from './FolderTree';

const DEEP_TREE: TreeResponse = {
  folders: ['A', 'A/B', 'A/B/C', 'X'],
  docs: [
    { path: 'A/B/C/深い.md', title: '深い', folder: 'A/B/C', updatedAt: '2026-07-01T00:00:00+09:00' },
    { path: 'X/別.md', title: '別', folder: 'X', updatedAt: '2026-07-01T00:00:00+09:00' },
    { path: 'ルート.md', title: 'ルート', folder: '', updatedAt: '2026-07-01T00:00:00+09:00' },
  ],
};

let nav: (path: string) => void;

function NavProbe() {
  const navigate = useNavigate();
  nav = navigate;
  return <div data-testid="nav-probe">probe</div>;
}

function Shell() {
  useFollowActiveDocInTree();
  const tab = useUIStore((s) => s.sidebarTab);
  return (
    <>
      <aside>{tab === 'folder' ? <FolderTree /> : <div data-testid="tag-pane" />}</aside>
      <Outlet />
    </>
  );
}

function renderShell(initialPath = '/') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url === '/api/tree') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(DEEP_TREE),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }),
  );

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
          <Route element={<Shell />}>
            <Route path="/" element={<NavProbe />} />
            <Route path="doc/*" element={<NavProbe />} />
            <Route path="history/*" element={<NavProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return { ...utils, queryClient };
}

describe('FolderTree follow integration (#323)', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    useUIStore.setState({
      expandedFolders: new Set(),
      revealRequest: null,
      sidebarTab: 'folder',
    });
    useEditStore.setState({ dirty: false });
    useToastStore.setState({ toast: null });
  });

  afterEach(() => {
    delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    cleanup();
    useUIStore.setState({
      expandedFolders: new Set(),
      revealRequest: null,
      sidebarTab: 'folder',
    });
  });

  it('I-1: URL /doc/A/B/C/深い.md でマウントすると自動展開・ハイライトされ scrollIntoView が呼ばれる', async () => {
    renderShell('/doc/A/B/C/深い.md');

    const docEl = await screen.findByTestId('doc-A/B/C/深い.md');
    expect(docEl).toBeTruthy();
    expect(docEl.className).toContain('text-accent');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('I-2: 手動でフォルダを閉じた後、tree を invalidate しても閉じたままで再展開しない', async () => {
    const { queryClient } = renderShell('/doc/A/B/C/深い.md');
    await screen.findByTestId('doc-A/B/C/深い.md');

    const folderBBtn = screen.getByText('B').closest('button')!;
    fireEvent.click(folderBBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('doc-A/B/C/深い.md')).toBeNull();
    });

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
    });

    expect(screen.queryByTestId('doc-A/B/C/深い.md')).toBeNull();
  });

  it('I-3: 別の文書に navigate するとその祖先が展開され、以前閉じた無関係なフォルダは閉じたまま', async () => {
    renderShell('/doc/A/B/C/深い.md');
    await screen.findByTestId('doc-A/B/C/深い.md');

    const folderBBtn = screen.getByText('B').closest('button')!;
    fireEvent.click(folderBBtn);
    await waitFor(() => {
      expect(screen.queryByTestId('doc-A/B/C/深い.md')).toBeNull();
    });

    act(() => {
      nav('/doc/X/別.md');
    });

    const docXEl = await screen.findByTestId('doc-X/別.md');
    expect(docXEl).toBeTruthy();
    expect(screen.queryByTestId('doc-A/B/C/深い.md')).toBeNull();
  });

  it('I-4: タグタブ表示中に navigate してもタブは維持され、フォルダタブ切替時にスクロールされる', async () => {
    useUIStore.setState({ sidebarTab: 'tag' });
    renderShell('/doc/X/別.md');

    expect(screen.getByTestId('tag-pane')).toBeTruthy();
    expect(screen.queryByTestId('doc-X/別.md')).toBeNull();

    act(() => {
      nav('/doc/A/B/C/深い.md');
    });

    // タグ表示のままであること
    expect(screen.getByTestId('tag-pane')).toBeTruthy();
    expect(useUIStore.getState().sidebarTab).toBe('tag');

    // フォルダタブに切り替える
    act(() => {
      useUIStore.getState().setSidebarTab('folder');
    });

    const docEl = await screen.findByTestId('doc-A/B/C/深い.md');
    expect(docEl).toBeTruthy();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });
});
