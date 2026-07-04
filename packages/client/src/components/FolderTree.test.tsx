import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEditStore } from '../stores/edit';
import { useUIStore } from '../stores/ui';
import { FolderTree } from './FolderTree';

const TREE = {
  folders: ['フォルダA'],
  docs: [
    { path: 'フォルダA/子文書.md', title: '子文書', folder: 'フォルダA', updatedAt: '2026-07-01T00:00:00+09:00' },
    { path: 'ルート文書.md', title: 'ルート文書', folder: '', updatedAt: '2026-07-01T00:00:00+09:00' },
    { path: '見出し#1.md', title: '見出し#1', folder: '', updatedAt: '2026-07-01T00:00:00+09:00' },
  ],
};

function renderFolderTree(initialPath = '/') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(TREE) }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/" element={<FolderTree />} />
          <Route path="/doc/*" element={<FolderTree />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('FolderTree', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    useUIStore.setState({ expandedFolders: new Set() });
    useEditStore.setState({ dirty: false });
  });

  it('ルート直下の文書とフォルダを表示し、フォルダは初期状態で折りたたまれている', async () => {
    renderFolderTree();

    expect(await screen.findByText('フォルダA')).toBeTruthy();
    expect(screen.getByText('ルート文書')).toBeTruthy();
    expect(screen.queryByText('子文書')).toBeNull();
  });

  it('フォルダをクリックすると展開し、配下の文書が表示される', async () => {
    renderFolderTree();
    await screen.findByText('フォルダA');

    fireEvent.click(screen.getByText('フォルダA'));

    expect(await screen.findByText('子文書')).toBeTruthy();
  });

  it('現在表示中の文書がハイライトされる', async () => {
    renderFolderTree('/doc/ルート文書.md');

    const el = await screen.findByTestId('doc-ルート文書.md');
    expect(el.className).toContain('text-blue-700');
  });

  it('#等の特殊文字を含む文書パスでも、遷移先でuseParams["*"]に完全なパスが渡る', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(TREE) }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function ParamsProbe() {
      const params = useParams();
      return <div data-testid="params-probe">{params['*']}</div>;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<FolderTree />} />
            <Route path="/doc/*" element={<ParamsProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByText('見出し#1'));

    const probe = await screen.findByTestId('params-probe');
    expect(probe.textContent).toBe('見出し#1.md');
  });
});
