import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(el.className).toContain('text-accent');
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

  it('↓キーで次の行にフォーカスが移動する', async () => {
    renderFolderTree();
    const folderRow = (await screen.findByText('フォルダA')).closest('button')!;
    folderRow.focus();

    fireEvent.keyDown(folderRow, { key: 'ArrowDown' });

    expect(document.activeElement).not.toBeNull();
    expect(document.activeElement).not.toBe(folderRow);
    expect(document.activeElement?.tagName).toBe('BUTTON');
  });

  it('→キーで折りたたまれたフォルダが展開される', async () => {
    renderFolderTree();
    const folderRow = (await screen.findByText('フォルダA')).closest('button')!;
    folderRow.focus();

    fireEvent.keyDown(folderRow, { key: 'ArrowRight' });

    expect(await screen.findByText('子文書')).toBeTruthy();
  });

  it('F2キーでリネームダイアログが開く', async () => {
    renderFolderTree();
    const docRow = (await screen.findByText('ルート文書')).closest('button')!;
    docRow.focus();

    fireEvent.keyDown(docRow, { key: 'F2' });

    expect(await screen.findByText('文書のリネーム')).toBeTruthy();
  });

  it('Deleteキーで削除確認ダイアログが開く', async () => {
    renderFolderTree();
    const docRow = (await screen.findByText('ルート文書')).closest('button')!;
    docRow.focus();

    fireEvent.keyDown(docRow, { key: 'Delete' });

    expect(await screen.findByText('文書の削除')).toBeTruthy();
  });

  describe('ドラッグ&ドロップ移動(#71)', () => {
    interface Call {
      method: string;
      path: string;
      body: unknown;
    }

    function stubFetchRecording(): Call[] {
      const calls: Call[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: RequestInit) => {
          const method = (init?.method ?? 'GET').toUpperCase();
          const [reqPath] = url.split('?');
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
          calls.push({ method, path: reqPath, body });
          // GET /api/docs (ツリー)は TREE を返す。他は成功
          if (method === 'GET') {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(TREE) });
          }
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
        }),
      );
      return calls;
    }

    function renderRecording() {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <FolderTree />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    }

    it('文書をフォルダ行にドロップすると moveDoc が呼ばれる', async () => {
      const calls = stubFetchRecording();
      renderRecording();
      const folderRow = (await screen.findByText('フォルダA')).closest('button')!;
      const docRow = (await screen.findByText('ルート文書')).closest('button')!;

      fireEvent.dragStart(docRow);
      fireEvent.dragEnter(folderRow);
      fireEvent.dragOver(folderRow);
      fireEvent.drop(folderRow);
      fireEvent.dragEnd(docRow);

      await waitFor(() => {
        expect(calls.some((c) => c.method === 'POST' && c.path === '/api/docs/move')).toBe(true);
      });
      const move = calls.find((c) => c.method === 'POST' && c.path === '/api/docs/move')!;
      expect(move.body).toEqual({
        path: 'ルート文書.md',
        newFolder: 'フォルダA',
        newTitle: 'ルート文書',
      });
    });

    it('同じ親フォルダへのドロップは移動APIを呼ばない(no-op)', async () => {
      const calls = stubFetchRecording();
      renderRecording();
      // フォルダA を開いて子文書を出す
      fireEvent.click(await screen.findByText('フォルダA'));
      const folderRow = (await screen.findByText('フォルダA')).closest('button')!;
      const childRow = (await screen.findByText('子文書')).closest('button')!;

      // 子文書 → 親フォルダA へドロップ = 元の親フォルダと同じなので no-op
      fireEvent.dragStart(childRow);
      fireEvent.dragEnter(folderRow);
      fireEvent.dragOver(folderRow);
      fireEvent.drop(folderRow);
      fireEvent.dragEnd(childRow);

      // 移動APIが叩かれないこと(ちょっと待って確認)
      await new Promise((r) => setTimeout(r, 20));
      expect(calls.some((c) => c.method === 'POST' && c.path.startsWith('/api/'))).toBe(false);
    });

    it('Ctrl+クリックで複数選択し、選択中の1つを別フォルダへドラッグすると全件が一括移動される(#72)', async () => {
      const calls = stubFetchRecording();
      renderRecording();
      const doc1 = (await screen.findByText('ルート文書')).closest('button')!;
      const doc2 = (await screen.findByText('見出し#1')).closest('button')!;
      const folder = (await screen.findByText('フォルダA')).closest('button')!;

      // Ctrl+クリックで2件選択(遷移せず選択のみ)
      fireEvent.click(doc1, { ctrlKey: true });
      fireEvent.click(doc2, { ctrlKey: true });

      // 選択中の1つを掴んでフォルダAへドロップ
      fireEvent.dragStart(doc1);
      fireEvent.dragEnter(folder);
      fireEvent.dragOver(folder);
      fireEvent.drop(folder);
      fireEvent.dragEnd(doc1);

      await waitFor(() => {
        const moves = calls.filter((c) => c.method === 'POST' && c.path === '/api/docs/move');
        expect(moves.length).toBe(2);
      });
      const moves = calls.filter((c) => c.method === 'POST' && c.path === '/api/docs/move');
      const movedPaths = new Set(moves.map((m) => (m.body as { path: string }).path));
      expect(movedPaths.has('ルート文書.md')).toBe(true);
      expect(movedPaths.has('見出し#1.md')).toBe(true);
    });
  });
});
