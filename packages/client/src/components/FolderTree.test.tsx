import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import type { TreeResponse } from '@tsumiwiki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { docUrl } from '../lib/doc-path';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { useUIStore } from '../stores/ui';
import { useUserSettingsStore } from '../stores/user-settings';
import { FolderTree } from './FolderTree';

const TREE = {
  folders: ['フォルダA'],
  docs: [
    {
      path: 'フォルダA/子文書.md',
      title: '子文書',
      folder: 'フォルダA',
      updatedAt: '2026-07-01T00:00:00+09:00',
    },
    {
      path: 'ルート文書.md',
      title: 'ルート文書',
      folder: '',
      updatedAt: '2026-07-01T00:00:00+09:00',
    },
    { path: '見出し#1.md', title: '見出し#1', folder: '', updatedAt: '2026-07-01T00:00:00+09:00' },
  ],
};

function renderFolderTree(initialPath = '/', tree: TreeResponse = TREE) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(tree) }),
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
    useUIStore.setState({ expandedFolders: new Set(), revealRequest: null, sidebarTab: 'folder' });
    useEditStore.setState({ dirty: false });
    localStorage.clear();
    useUserSettingsStore.setState({ showAttachmentsInTree: false });
    useUserSettingsStore.persist.clearStorage();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    delete (document as unknown as { execCommand?: unknown }).execCommand;
    useToastStore.setState({ toast: null });
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

  it('F2キーでインラインリネーム入力欄が表示される(#152)', async () => {
    renderFolderTree();
    const docRow = (await screen.findByText('ルート文書')).closest('button')!;
    docRow.focus();

    fireEvent.keyDown(docRow, { key: 'F2' });

    expect(await screen.findByTestId('inline-rename-input')).toBeTruthy();
  });

  it('ダブルクリックでインラインリネーム入力欄が表示される(#152)', async () => {
    renderFolderTree();
    const docRow = (await screen.findByText('ルート文書')).closest('button')!;

    fireEvent.doubleClick(docRow);

    expect(await screen.findByTestId('inline-rename-input')).toBeTruthy();
  });

  it('#216 サブフォルダを持つフォルダをリネームしても、展開状態が新パスに追従して子が消えない', async () => {
    // ネスト構造: 親 → 親/子 → 親/子/メモ.md
    const nested = {
      folders: ['親', '親/子'],
      docs: [
        {
          path: '親/子/メモ.md',
          title: 'メモ',
          folder: '親/子',
          updatedAt: '2026-08-23T00:00:00+09:00',
        },
      ],
    };
    const nestedAfter = {
      folders: ['新親', '新親/子'],
      docs: [
        {
          path: '新親/子/メモ.md',
          title: 'メモ',
          folder: '新親/子',
          updatedAt: '2026-08-23T00:00:00+09:00',
        },
      ],
    };
    let renamed = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const [reqPath] = url.split('?');
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        if (method === 'GET' && reqPath === '/api/tree') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(renamed ? nestedAfter : nested),
          });
        }
        if (method === 'POST' && reqPath === '/api/folders/move') {
          const b = body as { newPath: string };
          renamed = true;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ path: b.newPath }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true }),
        });
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<FolderTree />} />
            <Route path="/doc/*" element={<FolderTree />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // 親を展開して子を表示させる
    fireEvent.click(await screen.findByText('親'));
    expect(await screen.findByText('子')).toBeTruthy();

    // 親を F2 でインラインリネーム、新親 に変更
    const parentRow = screen.getByText('親').closest('button')!;
    parentRow.focus();
    fireEvent.keyDown(parentRow, { key: 'F2' });
    const input = await screen.findByTestId('inline-rename-input');
    fireEvent.change(input, { target: { value: '新親' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // 新パスで名前が反映され、なおかつ展開状態が付け替えられて子が見えたままである
    await waitFor(() => expect(screen.getByText('新親')).toBeTruthy());
    expect(screen.queryByText('親')).toBeNull();
    // 子(新親/子)はサブフォルダ名として表示されている必要がある
    expect(screen.getByText('子')).toBeTruthy();
    expect(useUIStore.getState().expandedFolders.has('新親')).toBe(true);
    expect(useUIStore.getState().expandedFolders.has('親')).toBe(false);
  });

  it('#216 深いネスト(親と親/子の両方展開)のリネームで prefix 経路が新パスに追従する', async () => {
    // 親も 親/子 も両方 expanded になっている状態でリネームすると、
    // repathExpandedFolder の `startsWith(${oldPath}/)` 分岐が正しく効いて
    // 新親/子 まで展開状態を維持する必要がある(#216 の主目的の一つ)
    const nested = {
      folders: ['親', '親/子', '親/子/孫'],
      docs: [
        {
          path: '親/子/孫/メモ.md',
          title: 'メモ',
          folder: '親/子/孫',
          updatedAt: '2026-08-23T00:00:00+09:00',
        },
      ],
    };
    const nestedAfter = {
      folders: ['新親', '新親/子', '新親/子/孫'],
      docs: [
        {
          path: '新親/子/孫/メモ.md',
          title: 'メモ',
          folder: '新親/子/孫',
          updatedAt: '2026-08-23T00:00:00+09:00',
        },
      ],
    };
    let renamed = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const [reqPath] = url.split('?');
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        if (method === 'GET' && reqPath === '/api/tree') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(renamed ? nestedAfter : nested),
          });
        }
        if (method === 'POST' && reqPath === '/api/folders/move') {
          const b = body as { newPath: string };
          renamed = true;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ path: b.newPath }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true }),
        });
      }),
    );
    // 事前に「親」「親/子」両方を展開状態としてストアに積む
    useUIStore.setState({ expandedFolders: new Set(['親', '親/子']) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<FolderTree />} />
            <Route path="/doc/*" element={<FolderTree />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // 深いネストの孫まで見えている(親と親/子 が展開されているため)
    expect(await screen.findByText('孫')).toBeTruthy();

    // 親を F2 → 新親 にリネーム
    const parentRow = (await screen.findByText('親')).closest('button')!;
    parentRow.focus();
    fireEvent.keyDown(parentRow, { key: 'F2' });
    const input = await screen.findByTestId('inline-rename-input');
    fireEvent.change(input, { target: { value: '新親' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // 新親/子/孫 まで expanded が付け替わっており、孫が引き続き見える
    await waitFor(() => expect(screen.getByText('新親')).toBeTruthy());
    expect(screen.getByText('子')).toBeTruthy();
    expect(screen.getByText('孫')).toBeTruthy();
    const exp = useUIStore.getState().expandedFolders;
    expect(exp.has('新親')).toBe(true);
    expect(exp.has('新親/子')).toBe(true);
    expect(exp.has('親')).toBe(false);
    expect(exp.has('親/子')).toBe(false);
  });

  it('#216 フォルダを D&D で別フォルダへ移動しても展開状態が新パスに追従する', async () => {
    // 移動元: A/子(展開)、移動先: B(空)。A/子 を B の中にドロップして B/子 へ。
    const initial = {
      folders: ['A', 'A/子', 'B'],
      docs: [
        {
          path: 'A/子/メモ.md',
          title: 'メモ',
          folder: 'A/子',
          updatedAt: '2026-08-23T00:00:00+09:00',
        },
      ],
    };
    const after = {
      folders: ['A', 'B', 'B/子'],
      docs: [
        {
          path: 'B/子/メモ.md',
          title: 'メモ',
          folder: 'B/子',
          updatedAt: '2026-08-23T00:00:00+09:00',
        },
      ],
    };
    let moved = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const [reqPath] = url.split('?');
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        if (method === 'GET' && reqPath === '/api/tree') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(moved ? after : initial),
          });
        }
        if (method === 'POST' && reqPath === '/api/folders/move') {
          const b = body as { newPath: string };
          moved = true;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ path: b.newPath }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true }),
        });
      }),
    );
    // 「A」「A/子」を展開状態にしておく
    useUIStore.setState({ expandedFolders: new Set(['A', 'A/子']) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<FolderTree />} />
            <Route path="/doc/*" element={<FolderTree />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // 事前確認: A/子 の中のメモが見えている
    expect(await screen.findByText('メモ')).toBeTruthy();

    // A/子 を B にドラッグアンドドロップ
    const src = (await screen.findByText('子')).closest('button')!;
    const dst = (await screen.findByText('B')).closest('button')!;
    fireEvent.dragStart(src);
    fireEvent.dragEnter(dst);
    fireEvent.dragOver(dst);
    fireEvent.drop(dst);
    fireEvent.dragEnd(src);

    // 展開状態が A/子 → B/子 に付け替わる
    await waitFor(() => {
      const exp = useUIStore.getState().expandedFolders;
      expect(exp.has('B/子')).toBe(true);
    });
    const exp = useUIStore.getState().expandedFolders;
    expect(exp.has('A/子')).toBe(false);
    // A 自体は動いていないので expanded のまま
    expect(exp.has('A')).toBe(true);
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
          // #97: move系はサーバー正規化パスを返す実挙動に合わせ、リクエストから新パスを組み立てて返す
          if (method === 'POST' && reqPath === '/api/docs/move') {
            const b = body as { newFolder: string; newTitle: string };
            const newPath = b.newFolder ? `${b.newFolder}/${b.newTitle}.md` : `${b.newTitle}.md`;
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ path: newPath }),
            });
          }
          if (method === 'POST' && reqPath === '/api/docs/move-batch') {
            const b = body as { moves: { path: string; newFolder: string; newTitle: string }[] };
            const moved = b.moves.map((m) => ({
              oldPath: m.path,
              path: m.newFolder ? `${m.newFolder}/${m.newTitle}.md` : `${m.newTitle}.md`,
            }));
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ moved, skippedAttachments: [] }),
            });
          }
          if (method === 'POST' && reqPath === '/api/folders/move') {
            const b = body as { newPath: string };
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ path: b.newPath }),
            });
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ ok: true }),
          });
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

    it('祖先フォルダと配下の文書を同時選択して移動しても、配下は除外される(#76 fix-forward)', async () => {
      const calls = stubFetchRecording();
      renderRecording();
      // フォルダAを展開
      fireEvent.click(await screen.findByText('フォルダA'));
      const folderA = (await screen.findByText('フォルダA')).closest('button')!;
      const childInA = (await screen.findByText('子文書')).closest('button')!;
      const rootDoc = (await screen.findByText('ルート文書')).closest('button')!;

      // Ctrl+クリックで「フォルダA」+「フォルダA/子文書」を選択(親と子孫の同時選択)
      fireEvent.click(folderA, { ctrlKey: true });
      fireEvent.click(childInA, { ctrlKey: true });
      fireEvent.dragStart(folderA);
      fireEvent.dragEnd(folderA);

      // ルート文書 rootDoc を Ctrl+選択して合計3件に、そのうえで rootDoc をドラッグしてフォルダAへ
      fireEvent.click(rootDoc, { ctrlKey: true });
      fireEvent.dragStart(rootDoc);
      fireEvent.dragEnter(folderA);
      fireEvent.dragOver(folderA);
      fireEvent.drop(folderA);
      fireEvent.dragEnd(rootDoc);

      await waitFor(() => {
        const batchCalls = calls.filter(
          (c) => c.method === 'POST' && c.path === '/api/docs/move-batch',
        );
        expect(batchCalls.length).toBe(1);
      });
      const batch = calls.find((c) => c.method === 'POST' && c.path === '/api/docs/move-batch')!;
      const movedPaths = new Set(
        (batch.body as { moves: { path: string }[] }).moves.map((m) => m.path),
      );
      expect(movedPaths.has('ルート文書.md')).toBe(true);
      // 子文書は 親と一緒に fs 上ついてくるので個別移動 API では叩かれない
      expect(movedPaths.has('フォルダA/子文書.md')).toBe(false);
    });

    it('選択したものを新規フォルダに移動するとフォルダ作成→対象を一括移動する(#73)', async () => {
      const calls = stubFetchRecording();
      renderRecording();
      const doc1 = (await screen.findByText('ルート文書')).closest('button')!;
      const doc2 = (await screen.findByText('見出し#1')).closest('button')!;

      // Ctrl+クリックで2件選択
      fireEvent.click(doc1, { ctrlKey: true });
      fireEvent.click(doc2, { ctrlKey: true });

      // 『+ 選択したものを新規フォルダに移動』ボタンをクリック
      fireEvent.click(screen.getByRole('button', { name: /選択したものを新規フォルダに移動/ }));

      // ダイアログでフォルダ名入力
      const input = await screen.findByRole('textbox');
      fireEvent.change(input, { target: { value: 'まとめ' } });
      fireEvent.click(screen.getByRole('button', { name: '作成して移動' }));

      // POST /api/folders → POST /api/docs/move-batch の順で呼ばれる
      await waitFor(() => {
        expect(calls.some((c) => c.method === 'POST' && c.path === '/api/folders')).toBe(true);
      });
      const createFolderCall = calls.find((c) => c.method === 'POST' && c.path === '/api/folders');
      expect(createFolderCall?.body).toEqual({ path: 'まとめ' });

      await waitFor(() => {
        const batches = calls.filter(
          (c) => c.method === 'POST' && c.path === '/api/docs/move-batch',
        );
        expect(batches.length).toBe(1);
      });
      const batch = calls.find((c) => c.method === 'POST' && c.path === '/api/docs/move-batch')!;
      const moves = (batch.body as { moves: { path: string; newFolder: string }[] }).moves;
      expect(new Set(moves.map((m) => m.path))).toEqual(new Set(['ルート文書.md', '見出し#1.md']));
      expect(new Set(moves.map((m) => m.newFolder))).toEqual(new Set(['まとめ']));
    });

    it('Ctrl+クリックで複数選択し、選択中の1つを別フォルダへドラッグすると一括移動APIが1回呼ばれる(#72 / #334)', async () => {
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
        const batches = calls.filter(
          (c) => c.method === 'POST' && c.path === '/api/docs/move-batch',
        );
        expect(batches.length).toBe(1);
      });
      const batch = calls.find((c) => c.method === 'POST' && c.path === '/api/docs/move-batch')!;
      const movedPaths = new Set(
        (batch.body as { moves: { path: string }[] }).moves.map((m) => m.path),
      );
      expect(movedPaths.has('ルート文書.md')).toBe(true);
      expect(movedPaths.has('見出し#1.md')).toBe(true);
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/docs/move')).toBe(false);
    });

    it('文書バッチ＋フォルダの一括移動ではステップ成功ごとにツリー refetch を挟む(#163)', async () => {
      const TREE_WITH_B = {
        folders: ['フォルダA', 'フォルダB'],
        docs: [
          {
            path: 'ルート文書.md',
            title: 'ルート文書',
            folder: '',
            updatedAt: '2026-07-01T00:00:00+09:00',
          },
        ],
      };
      const calls = stubFetchWithTree(TREE_WITH_B);
      renderWithProbeAt('/doc/ルート文書.md');
      const folderA = (await screen.findByText('フォルダA')).closest('button')!;
      const rootDoc = (await screen.findByText('ルート文書')).closest('button')!;
      const folderB = (await screen.findByText('フォルダB')).closest('button')!;

      fireEvent.click(rootDoc, { ctrlKey: true });
      fireEvent.click(folderA, { ctrlKey: true });
      fireEvent.dragStart(rootDoc);
      fireEvent.dragEnter(folderB);
      fireEvent.dragOver(folderB);
      fireEvent.drop(folderB);
      fireEvent.dragEnd(rootDoc);

      await waitFor(() => {
        const docBatch = calls.some(
          (c) => c.method === 'POST' && c.path === '/api/docs/move-batch',
        );
        const folderMove = calls.some((c) => c.method === 'POST' && c.path === '/api/folders/move');
        expect(docBatch && folderMove).toBe(true);
      });
      const batchIdx = calls.findIndex(
        (c) => c.method === 'POST' && c.path === '/api/docs/move-batch',
      );
      const folderIdx = calls.findIndex(
        (c) => c.method === 'POST' && c.path === '/api/folders/move',
      );
      const treeBetween = calls
        .slice(batchIdx + 1, folderIdx)
        .some((c) => c.method === 'GET' && c.path === '/api/tree');
      expect(treeBetween).toBe(true);
    });

    it('#163 全件失敗時でも末尾で TREE invalidate をフォールバックする', async () => {
      const TREE_ALL = {
        folders: ['先'],
        docs: [
          { path: 'a.md', title: 'a', folder: '', updatedAt: '2026-07-01T00:00:00+09:00' },
          { path: 'b.md', title: 'b', folder: '', updatedAt: '2026-07-01T00:00:00+09:00' },
        ],
      };
      vi.unstubAllGlobals();
      const calls2: Call[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: RequestInit) => {
          const method = (init?.method ?? 'GET').toUpperCase();
          const [reqPath] = url.split('?');
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
          calls2.push({ method, path: reqPath, body });
          if (method === 'GET') {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(TREE_ALL),
            });
          }
          if (method === 'POST' && reqPath === '/api/docs/move-batch') {
            return Promise.resolve({
              ok: false,
              status: 500,
              json: () => Promise.resolve({ error: { code: 'INTERNAL_ERROR', message: 'x' } }),
            });
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ ok: true }),
          });
        }),
      );
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route path="/" element={<FolderTree />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      const docA = (await screen.findByText('a')).closest('button')!;
      const docB = (await screen.findByText('b')).closest('button')!;
      const folder = (await screen.findByText('先')).closest('button')!;
      fireEvent.click(docA, { ctrlKey: true });
      fireEvent.click(docB, { ctrlKey: true });
      fireEvent.dragStart(docA);
      fireEvent.dragEnter(folder);
      fireEvent.dragOver(folder);
      fireEvent.drop(folder);
      fireEvent.dragEnd(docA);

      await waitFor(() => {
        const batches = calls2.filter(
          (c) => c.method === 'POST' && c.path === '/api/docs/move-batch',
        );
        expect(batches.length).toBe(1);
      });
      const lastMoveIdx = calls2
        .map((c, i) => (c.method === 'POST' && c.path === '/api/docs/move-batch' ? i : -1))
        .filter((i) => i >= 0)
        .pop()!;
      await waitFor(() => {
        const treeAfterAllMoves = calls2
          .slice(lastMoveIdx + 1)
          .some((c) => c.method === 'GET' && c.path === '/api/tree');
        expect(treeAfterAllMoves).toBe(true);
      });
    });

    // #97 URL追従テスト群: 表示中文書のURLがバッチ移動でどう変わる/変わらないか
    function LocationProbe() {
      const location = useLocation();
      return <div data-testid="location-probe">{location.pathname}</div>;
    }

    function renderWithProbeAt(initialPath: string) {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[initialPath]}>
            <Routes>
              <Route
                path="/doc/*"
                element={
                  <>
                    <FolderTree />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    }

    // 任意ツリー・任意の失敗パス指定・skippedAttachments に対応した fetch スタブ
    function stubFetchWithTree(
      customTree: unknown,
      opts?: {
        failMoveDocPath?: string;
        skippedAttachments?: { fileName: string; reason: 'shared' | 'conflict' }[];
      },
    ): Call[] {
      const calls: Call[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: RequestInit) => {
          const method = (init?.method ?? 'GET').toUpperCase();
          const [reqPath] = url.split('?');
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
          calls.push({ method, path: reqPath, body });
          if (method === 'GET') {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(customTree),
            });
          }
          if (method === 'POST' && reqPath === '/api/docs/move') {
            const b = body as { path: string; newFolder: string; newTitle: string };
            if (opts?.failMoveDocPath && b.path === opts.failMoveDocPath) {
              return Promise.resolve({
                ok: false,
                status: 500,
                json: () =>
                  Promise.resolve({ error: { code: 'INTERNAL_ERROR', message: 'server error' } }),
              });
            }
            const newPath = b.newFolder ? `${b.newFolder}/${b.newTitle}.md` : `${b.newTitle}.md`;
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  path: newPath,
                  skippedAttachments: opts?.skippedAttachments ?? [],
                }),
            });
          }
          if (method === 'POST' && reqPath === '/api/docs/move-batch') {
            const b = body as { moves: { path: string; newFolder: string; newTitle: string }[] };
            if (opts?.failMoveDocPath && b.moves.some((m) => m.path === opts.failMoveDocPath)) {
              return Promise.resolve({
                ok: false,
                status: 500,
                json: () =>
                  Promise.resolve({ error: { code: 'INTERNAL_ERROR', message: 'server error' } }),
              });
            }
            const moved = b.moves.map((m) => ({
              oldPath: m.path,
              path: m.newFolder ? `${m.newFolder}/${m.newTitle}.md` : `${m.newTitle}.md`,
            }));
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  moved,
                  skippedAttachments: opts?.skippedAttachments ?? [],
                }),
            });
          }
          if (method === 'POST' && reqPath === '/api/folders/move') {
            const b = body as { newPath: string };
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ path: b.newPath }),
            });
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ ok: true }),
          });
        }),
      );
      return calls;
    }

    it('表示中文書を含む複数選択をバッチ移動すると、URLが移動後のパスへ追従する(#97)', async () => {
      stubFetchRecording();
      renderWithProbeAt('/doc/ルート文書.md');

      const doc1 = (await screen.findByText('ルート文書')).closest('button')!;
      const doc2 = (await screen.findByText('見出し#1')).closest('button')!;
      const folder = (await screen.findByText('フォルダA')).closest('button')!;

      // 表示中の「ルート文書」を含む2件を選択し、フォルダAへドラッグ&ドロップで一括移動
      fireEvent.click(doc1, { ctrlKey: true });
      fireEvent.click(doc2, { ctrlKey: true });
      fireEvent.dragStart(doc1);
      fireEvent.dragEnter(folder);
      fireEvent.dragOver(folder);
      fireEvent.drop(folder);
      fireEvent.dragEnd(doc1);

      await waitFor(() => {
        expect(screen.getByTestId('location-probe').textContent).toBe(
          docUrl('フォルダA/ルート文書.md'),
        );
      });
    });

    it('フォルダごとバッチ移動して、配下に表示中docがあると URL が「移動先/oldFolder/子doc」に追従する(#97)', async () => {
      const TREE_WITH_B = {
        folders: ['フォルダA', 'フォルダB'],
        docs: [
          {
            path: 'フォルダA/子文書.md',
            title: '子文書',
            folder: 'フォルダA',
            updatedAt: '2026-07-01T00:00:00+09:00',
          },
          {
            path: 'ルート文書.md',
            title: 'ルート文書',
            folder: '',
            updatedAt: '2026-07-01T00:00:00+09:00',
          },
        ],
      };
      const calls = stubFetchWithTree(TREE_WITH_B);
      renderWithProbeAt('/doc/フォルダA/子文書.md');

      const folderA = (await screen.findByText('フォルダA')).closest('button')!;
      const rootDoc = (await screen.findByText('ルート文書')).closest('button')!;
      const folderB = (await screen.findByText('フォルダB')).closest('button')!;

      // Ctrl+選択で「フォルダA」+「ルート文書」を選択(サイズ2でバッチ判定を満たす)
      fireEvent.click(folderA, { ctrlKey: true });
      fireEvent.click(rootDoc, { ctrlKey: true });

      // 選択中の folderA を掴んで folderB にドロップ = 一括移動発火
      fireEvent.dragStart(folderA);
      fireEvent.dragEnter(folderB);
      fireEvent.dragOver(folderB);
      fireEvent.drop(folderB);
      fireEvent.dragEnd(folderA);

      // 移動APIが叩かれた(folder + docバッチ)ことを待ってから URL 追従を確認
      await waitFor(() => {
        const folderMoves = calls.filter(
          (c) => c.method === 'POST' && c.path === '/api/folders/move',
        );
        const docMoves = calls.filter(
          (c) => c.method === 'POST' && c.path === '/api/docs/move-batch',
        );
        expect(folderMoves.length).toBe(1);
        expect(docMoves.length).toBe(1);
      });
      await waitFor(() => {
        expect(screen.getByTestId('location-probe').textContent).toBe(
          docUrl('フォルダB/フォルダA/子文書.md'),
        );
      });
    });

    it('表示中docが選択に含まれないバッチ移動では URL は変わらない(#97)', async () => {
      const calls = stubFetchRecording();
      const initial = '/doc/フォルダA/子文書.md';
      renderWithProbeAt(initial);

      const rootDoc = (await screen.findByText('ルート文書')).closest('button')!;
      const otherDoc = (await screen.findByText('見出し#1')).closest('button')!;
      const folder = (await screen.findByText('フォルダA')).closest('button')!;

      // 表示中 (フォルダA/子文書.md) は選ばず、他の2件を選択して フォルダA にドロップ
      fireEvent.click(rootDoc, { ctrlKey: true });
      fireEvent.click(otherDoc, { ctrlKey: true });
      fireEvent.dragStart(rootDoc);
      fireEvent.dragEnter(folder);
      fireEvent.dragOver(folder);
      fireEvent.drop(folder);
      fireEvent.dragEnd(rootDoc);

      await waitFor(() => {
        const batches = calls.filter(
          (c) => c.method === 'POST' && c.path === '/api/docs/move-batch',
        );
        expect(batches.length).toBe(1);
      });
      // 表示中文書は選択に含まれていないので URL は初期値のまま
      expect(screen.getByTestId('location-probe').textContent).toBe(initial);
    });

    it('表示中docを含むバッチ移動が失敗したときは URL が変わらない(#97)', async () => {
      const initial = '/doc/ルート文書.md';
      const calls = stubFetchWithTree(TREE, { failMoveDocPath: 'ルート文書.md' });
      renderWithProbeAt(initial);

      const rootDoc = (await screen.findByText('ルート文書')).closest('button')!;
      const otherDoc = (await screen.findByText('見出し#1')).closest('button')!;
      const folder = (await screen.findByText('フォルダA')).closest('button')!;

      // 表示中「ルート文書」+ 見出し#1 を選択して フォルダA にドロップ
      fireEvent.click(rootDoc, { ctrlKey: true });
      fireEvent.click(otherDoc, { ctrlKey: true });
      fireEvent.dragStart(rootDoc);
      fireEvent.dragEnter(folder);
      fireEvent.dragOver(folder);
      fireEvent.drop(folder);
      fireEvent.dragEnd(rootDoc);

      await waitFor(() => {
        const batches = calls.filter(
          (c) => c.method === 'POST' && c.path === '/api/docs/move-batch',
        );
        expect(batches.length).toBe(1);
      });
      // 表示中 doc の移動は失敗したので URL は初期値のまま
      expect(screen.getByTestId('location-probe').textContent).toBe(initial);
    });

    it('一括移動で共有添付が残置された場合、統合トーストで件数を通知する(#334)', async () => {
      useToastStore.setState({ toast: null });
      stubFetchWithTree(TREE, {
        skippedAttachments: [{ fileName: 'shared.png', reason: 'shared' }],
      });
      renderWithProbeAt('/doc/ルート文書.md');

      const doc1 = (await screen.findByText('ルート文書')).closest('button')!;
      const doc2 = (await screen.findByText('見出し#1')).closest('button')!;
      const folder = (await screen.findByText('フォルダA')).closest('button')!;

      fireEvent.click(doc1, { ctrlKey: true });
      fireEvent.click(doc2, { ctrlKey: true });
      fireEvent.dragStart(doc1);
      fireEvent.dragEnter(folder);
      fireEvent.dragOver(folder);
      fireEvent.drop(folder);
      fireEvent.dragEnd(doc1);

      await waitFor(() => {
        const toast = useToastStore.getState().toast;
        expect(toast?.kind).toBe('info');
        expect(toast?.message).toContain('2件を移動しました');
        expect(toast?.message).toContain('共有中の添付 1 件は元のフォルダに残しました');
      });
    });

    it('単体移動でも共有・衝突添付が残置された場合、トーストで件数を通知する(#334)', async () => {
      useToastStore.setState({ toast: null });
      stubFetchWithTree(TREE, {
        skippedAttachments: [
          { fileName: 'shared.png', reason: 'shared' },
          { fileName: 'dup.png', reason: 'conflict' },
        ],
      });
      renderWithProbeAt('/doc/ルート文書.md');

      const doc1 = (await screen.findByText('ルート文書')).closest('button')!;
      const folder = (await screen.findByText('フォルダA')).closest('button')!;

      fireEvent.dragStart(doc1);
      fireEvent.dragEnter(folder);
      fireEvent.dragOver(folder);
      fireEvent.drop(folder);
      fireEvent.dragEnd(doc1);

      await waitFor(() => {
        const toast = useToastStore.getState().toast;
        expect(toast?.kind).toBe('info');
        expect(toast?.message).toContain('共有中の添付 1 件は元のフォルダに残しました');
        expect(toast?.message).toContain(
          '移動先に同名ファイルがあるため添付 1 件は元のフォルダに残しました',
        );
      });
    });

    it('201件以上の文書を一括移動すると 200 件単位に分割して /api/docs/move-batch を呼ぶ(#334 M3)', async () => {
      useToastStore.setState({ toast: null });
      const docs201 = Array.from({ length: 201 }, (_, idx) => ({
        path: `doc-${String(idx).padStart(3, '0')}.md`,
        title: `doc-${String(idx).padStart(3, '0')}`,
        folder: '',
        updatedAt: '2026-07-01T00:00:00+09:00',
      }));
      const calls = stubFetchWithTree({ folders: ['移動先'], docs: docs201 });
      renderWithProbeAt('/doc/doc-000.md');

      const firstDoc = (await screen.findByText('doc-000')).closest('button')!;
      const lastDoc = (await screen.findByText('doc-200')).closest('button')!;
      const destFolder = (await screen.findByText('移動先')).closest('button')!;

      fireEvent.click(firstDoc);
      fireEvent.click(lastDoc, { shiftKey: true });
      fireEvent.dragStart(firstDoc);
      fireEvent.dragEnter(destFolder);
      fireEvent.dragOver(destFolder);
      fireEvent.drop(destFolder);
      fireEvent.dragEnd(firstDoc);

      await waitFor(() => {
        const batches = calls.filter(
          (c) => c.method === 'POST' && c.path === '/api/docs/move-batch',
        );
        expect(batches.length).toBe(2);
        expect((batches[0].body as { moves: unknown[] }).moves.length).toBe(200);
        expect((batches[1].body as { moves: unknown[] }).moves.length).toBe(1);
      });
      await waitFor(() => {
        const toast = useToastStore.getState().toast;
        expect(toast?.kind).toBe('success');
        expect(toast?.message).toBe('201件を移動しました');
      });
    });

    describe('#169: 文書行へのドロップで親フォルダに移動', () => {
      it('展開フォルダ配下の文書行にドロップすると、その親フォルダへ移動する', async () => {
        const calls = stubFetchRecording();
        renderRecording();
        // フォルダA を展開して子文書を表示
        fireEvent.click(await screen.findByText('フォルダA'));
        const childRow = (await screen.findByText('子文書')).closest('button')!;
        const rootDoc = (await screen.findByText('ルート文書')).closest('button')!;

        // ルート文書 を フォルダA/子文書 の行にドロップ → フォルダA へ移動
        fireEvent.dragStart(rootDoc);
        fireEvent.dragEnter(childRow);
        fireEvent.dragOver(childRow);
        fireEvent.drop(childRow);
        fireEvent.dragEnd(rootDoc);

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

      it('同一フォルダ内の兄弟文書行へのドロップは移動APIを呼ばない(no-op)', async () => {
        const calls = stubFetchRecording();
        renderRecording();
        const rootDoc = (await screen.findByText('ルート文書')).closest('button')!;
        const otherRootDoc = (await screen.findByText('見出し#1')).closest('button')!;

        // 両方ルート直下 → 親が同じ = 移動しても意味なし
        fireEvent.dragStart(rootDoc);
        fireEvent.dragEnter(otherRootDoc);
        fireEvent.dragOver(otherRootDoc);
        fireEvent.drop(otherRootDoc);
        fireEvent.dragEnd(rootDoc);

        await new Promise((r) => setTimeout(r, 20));
        expect(calls.some((c) => c.method === 'POST' && c.path.startsWith('/api/'))).toBe(false);
      });

      it('フォルダ配下の文書をルート直下の文書行にドロップするとルートへ移動する', async () => {
        const calls = stubFetchRecording();
        renderRecording();
        fireEvent.click(await screen.findByText('フォルダA'));
        const childRow = (await screen.findByText('子文書')).closest('button')!;
        const rootDoc = (await screen.findByText('ルート文書')).closest('button')!;

        // 子文書 を ルート文書行 にドロップ → ルート('')へ移動
        fireEvent.dragStart(childRow);
        fireEvent.dragEnter(rootDoc);
        fireEvent.dragOver(rootDoc);
        fireEvent.drop(rootDoc);
        fireEvent.dragEnd(childRow);

        await waitFor(() => {
          expect(calls.some((c) => c.method === 'POST' && c.path === '/api/docs/move')).toBe(true);
        });
        const move = calls.find((c) => c.method === 'POST' && c.path === '/api/docs/move')!;
        expect(move.body).toEqual({
          path: 'フォルダA/子文書.md',
          newFolder: '',
          newTitle: '子文書',
        });
      });

      it('受け入れ可の文書行の dragOver では preventDefault が呼ばれる', async () => {
        // Opus レビュー M3: canDropOn ガードだけでなく、実ブラウザ上で drop を発火させる
        // 前提条件である preventDefault が実際に走っているかを検証する
        stubFetchRecording();
        renderRecording();
        fireEvent.click(await screen.findByText('フォルダA'));
        const childRow = (await screen.findByText('子文書')).closest('button')!;
        const rootDoc = (await screen.findByText('ルート文書')).closest('button')!;

        fireEvent.dragStart(rootDoc);
        fireEvent.dragEnter(childRow);
        const evt = createEvent.dragOver(childRow);
        fireEvent(childRow, evt);
        expect(evt.defaultPrevented).toBe(true);
        fireEvent.dragEnd(rootDoc);
      });

      it('同一親の兄弟文書行の dragOver でも preventDefault は呼ばれる(#171: Safari 対策)、ただし dropEffect=none で禁止表示に', async () => {
        // Safari は初回 dragenter/dragover で preventDefault が無いとその要素を drop 不可と
        // 決めるため、内部 D&D 中は常に preventDefault する。落とせないケースは dropEffect=none で
        // カーソル表示を「禁止」にし、drop 側の canDropOn で API 発火を弾く
        stubFetchRecording();
        renderRecording();
        const rootDoc = (await screen.findByText('ルート文書')).closest('button')!;
        const otherRootDoc = (await screen.findByText('見出し#1')).closest('button')!;

        fireEvent.dragStart(rootDoc);
        fireEvent.dragEnter(otherRootDoc);
        const evt = createEvent.dragOver(otherRootDoc);
        fireEvent(otherRootDoc, evt);
        expect(evt.defaultPrevented).toBe(true);
        // dropEffect の実効(禁止カーソル)は jsdom の DataTransfer が dropEffect を持たないので
        // 検証できない。preventDefault が呼ばれることと、drop 後に API 発火が抑制されること
        // (既存の no-op テスト)で挙動を担保する
        fireEvent.dragEnd(rootDoc);
      });

      it('#171: 外部 D&D(dragStart 未経由 / draggedPath===null)の dragOver では preventDefault されない — 将来 OS ファイル drop 対応時の保護', async () => {
        stubFetchRecording();
        renderRecording();
        // フォルダAを展開して doc 行(親フォルダあり)と folder 行の両方でチェック
        fireEvent.click(await screen.findByText('フォルダA'));
        const folderRow = (await screen.findByText('フォルダA')).closest('button')!;
        const docRow = (await screen.findByText('子文書')).closest('button')!;

        // dragStart を呼ばずにいきなり dragOver を送る = 外部由来のドラッグ想定
        const evt1 = createEvent.dragOver(docRow);
        fireEvent(docRow, evt1);
        expect(evt1.defaultPrevented).toBe(false);

        const evt2 = createEvent.dragOver(folderRow);
        fireEvent(folderRow, evt2);
        expect(evt2.defaultPrevented).toBe(false);
      });

      it('フォルダを自分の配下の子文書行にドロップしても no-op(祖先→子孫は禁止)', async () => {
        const calls = stubFetchRecording();
        renderRecording();
        fireEvent.click(await screen.findByText('フォルダA'));
        const folderA = (await screen.findByText('フォルダA')).closest('button')!;
        const childRow = (await screen.findByText('子文書')).closest('button')!;

        // フォルダA を掴んで、そのフォルダ配下の子文書行(=親 = フォルダA)にドロップ
        // → canDropOn は同一親判定で弾く
        fireEvent.dragStart(folderA);
        fireEvent.dragEnter(childRow);
        fireEvent.dragOver(childRow);
        fireEvent.drop(childRow);
        fireEvent.dragEnd(folderA);

        await new Promise((r) => setTimeout(r, 20));
        expect(calls.some((c) => c.method === 'POST' && c.path.startsWith('/api/'))).toBe(false);
      });

      it('フォルダを別フォルダ配下の子文書行にドロップすると、その親フォルダ配下へ移動する', async () => {
        // フォルダBを追加して フォルダA を フォルダB/子 の行にドロップ → フォルダB配下へ
        const TREE2 = {
          folders: ['フォルダA', 'フォルダB'],
          docs: [
            {
              path: 'フォルダB/子B.md',
              title: '子B',
              folder: 'フォルダB',
              updatedAt: '2026-07-01T00:00:00+09:00',
            },
          ],
        };
        const calls: Call[] = [];
        vi.stubGlobal(
          'fetch',
          vi.fn((url: string, init?: RequestInit) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            const [reqPath] = url.split('?');
            const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
            calls.push({ method, path: reqPath, body });
            if (method === 'GET') {
              return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(TREE2) });
            }
            if (method === 'POST' && reqPath === '/api/folders/move') {
              const b = body as { newPath: string };
              return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ path: b.newPath }),
              });
            }
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ ok: true }),
            });
          }),
        );
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        render(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>
              <FolderTree />
            </MemoryRouter>
          </QueryClientProvider>,
        );
        fireEvent.click(await screen.findByText('フォルダB'));
        const folderA = (await screen.findByText('フォルダA')).closest('button')!;
        const childB = (await screen.findByText('子B')).closest('button')!;

        fireEvent.dragStart(folderA);
        fireEvent.dragEnter(childB);
        fireEvent.dragOver(childB);
        fireEvent.drop(childB);
        fireEvent.dragEnd(folderA);

        await waitFor(() => {
          expect(calls.some((c) => c.method === 'POST' && c.path === '/api/folders/move')).toBe(
            true,
          );
        });
        const move = calls.find((c) => c.method === 'POST' && c.path === '/api/folders/move')!;
        expect(move.body).toEqual({ path: 'フォルダA', newPath: 'フォルダB/フォルダA' });
      });

      it('複数選択中の1つを別フォルダの子文書行へドロップすると、全件がその親フォルダへ一括移動される', async () => {
        const calls = stubFetchRecording();
        renderRecording();
        fireEvent.click(await screen.findByText('フォルダA'));
        const childRow = (await screen.findByText('子文書')).closest('button')!;
        const doc1 = (await screen.findByText('ルート文書')).closest('button')!;
        const doc2 = (await screen.findByText('見出し#1')).closest('button')!;

        // Ctrl+クリックで2件選択
        fireEvent.click(doc1, { ctrlKey: true });
        fireEvent.click(doc2, { ctrlKey: true });

        // 選択中の doc1 を掴んで フォルダA/子文書 の行へドロップ → フォルダA へ2件とも移動
        fireEvent.dragStart(doc1);
        fireEvent.dragEnter(childRow);
        fireEvent.dragOver(childRow);
        fireEvent.drop(childRow);
        fireEvent.dragEnd(doc1);

        await waitFor(() => {
          const batches = calls.filter(
            (c) => c.method === 'POST' && c.path === '/api/docs/move-batch',
          );
          expect(batches.length).toBe(1);
        });
        const batch = calls.find((c) => c.method === 'POST' && c.path === '/api/docs/move-batch')!;
        const moves = (batch.body as { moves: { path: string; newFolder: string }[] }).moves;
        expect(new Set(moves.map((m) => m.path))).toEqual(
          new Set(['ルート文書.md', '見出し#1.md']),
        );
        expect(new Set(moves.map((m) => m.newFolder))).toEqual(new Set(['フォルダA']));
      });
    });
  });

  describe('右クリックメニューのコピー(#301)', () => {
    const toastMessage = () => useToastStore.getState().toast?.message;

    async function setup(
      writeText: unknown = vi.fn().mockResolvedValue(undefined),
      tree?: TreeResponse,
    ) {
      if (writeText) {
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      }
      renderFolderTree('/', tree);
      await screen.findByText('フォルダA');
      return writeText as ReturnType<typeof vi.fn>;
    }
    async function openChildDocMenu() {
      fireEvent.click(screen.getByText('フォルダA'));
      fireEvent.contextMenu(await screen.findByTestId('doc-フォルダA/子文書.md'));
    }
    const clickItem = (name: string) => fireEvent.click(screen.getByRole('menuitem', { name }));

    it('フォルダ内の文書の「パスをコピー」', async () => {
      const writeText = await setup();
      await openChildDocMenu();
      clickItem('パスをコピー');
      expect(writeText).toHaveBeenCalledWith('フォルダA/子文書.md');
      await waitFor(() => expect(toastMessage()).toBe('パスをコピーしました'));
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('フォルダの「パスをコピー」', async () => {
      const writeText = await setup();
      fireEvent.contextMenu(screen.getByText('フォルダA'));
      clickItem('パスをコピー');
      expect(writeText).toHaveBeenCalledWith('フォルダA');
    });

    it('入れ子フォルダのパス', async () => {
      const writeText = await setup(undefined, {
        folders: ['フォルダA', 'フォルダA/子フォルダ'],
        docs: [],
      });
      fireEvent.click(screen.getByText('フォルダA'));
      fireEvent.contextMenu(await screen.findByText('子フォルダ'));
      clickItem('パスをコピー');
      expect(writeText).toHaveBeenCalledWith('フォルダA/子フォルダ');
    });

    it('「wikilink形式でコピー」', async () => {
      const writeText = await setup();
      await openChildDocMenu();
      clickItem('wikilink形式でコピー');
      expect(writeText).toHaveBeenCalledWith('[[フォルダA/子文書]]');
      await waitFor(() => expect(toastMessage()).toBe('wikilinkをコピーしました'));
    });

    it('`#` を含む文書には wikilink 項目が出ない', async () => {
      await setup();
      fireEvent.contextMenu(await screen.findByTestId('doc-見出し#1.md'));
      expect(screen.queryByRole('menuitem', { name: 'wikilink形式でコピー' })).toBeNull();
      expect(screen.getByRole('menuitem', { name: 'パスをコピー' })).toBeTruthy();
    });

    it('「URLをコピー」', async () => {
      const writeText = await setup();
      await openChildDocMenu();
      clickItem('URLをコピー');
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}${docUrl('フォルダA/子文書.md')}`,
      );
      await waitFor(() => expect(toastMessage()).toBe('URLをコピーしました'));
    });

    it('フォルダのメニューに wikilink・URL は出ない', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByText('フォルダA'));
      expect(screen.queryByRole('menuitem', { name: 'wikilink形式でコピー' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'URLをコピー' })).toBeNull();
    });

    it('書き込み失敗でエラートースト', async () => {
      await setup(vi.fn().mockRejectedValue(new Error('denied')));
      fireEvent.contextMenu(screen.getByText('フォルダA'));
      clickItem('パスをコピー');
      await waitFor(() => expect(toastMessage()).toBe('コピーに失敗しました'));
      expect(useToastStore.getState().toast?.kind).toBe('error');
    });

    it('navigator.clipboard が無い環境(非セキュアコンテキスト相当)で失敗トースト', async () => {
      await setup(null);
      fireEvent.contextMenu(screen.getByText('フォルダA'));
      clickItem('パスをコピー');
      await waitFor(() => expect(toastMessage()).toBe('コピーに失敗しました'));
    });

    it('同期経路(execCommand)がクリックの中で走る', async () => {
      const writeText = await setup();
      const setData = vi.fn();
      (document as unknown as { execCommand: () => boolean }).execCommand = () => {
        const ev = new Event('copy');
        (ev as unknown as { clipboardData: unknown }).clipboardData = { setData };
        document.dispatchEvent(ev);
        return true;
      };
      fireEvent.contextMenu(await screen.findByTestId('doc-ルート文書.md'));
      clickItem('パスをコピー');
      expect(setData).toHaveBeenCalledWith('text/plain', 'ルート文書.md');
      expect(writeText).not.toHaveBeenCalled();
      await waitFor(() => expect(toastMessage()).toBe('パスをコピーしました'));
    });
  });

  describe('ツリー追従の要求消費 (#323)', () => {
    const DEEP_TREE_FOR_REVEAL: TreeResponse = {
      folders: ['A', 'A/B', 'A/B/C'],
      docs: [
        {
          path: 'A/B/C/深い.md',
          title: '深い',
          folder: 'A/B/C',
          updatedAt: '2026-07-01T00:00:00+09:00',
        },
      ],
    };

    beforeEach(() => {
      Element.prototype.scrollIntoView = vi.fn();
      useUIStore.setState({
        expandedFolders: new Set(),
        revealRequest: null,
        sidebarTab: 'folder',
      });
    });

    afterEach(() => {
      delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
      useUIStore.setState({
        expandedFolders: new Set(),
        revealRequest: null,
        sidebarTab: 'folder',
      });
    });

    it('F-1: unmount 中に積まれた revealRequest をマウント時に消費し scrollIntoView を呼ぶ', async () => {
      useUIStore.getState().revealInTree('A/B/C/深い.md');
      renderFolderTree('/doc/A/B/C/深い.md', DEEP_TREE_FOR_REVEAL);

      const docEl = await screen.findByTestId('doc-A/B/C/深い.md');
      expect(docEl).toBeTruthy();
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      expect(useUIStore.getState().revealRequest).toBeNull();
      expect(docEl.tabIndex).toBe(0);
      expect(docEl.className).toContain('text-accent');
    });

    it('F-2: マウント後に revealInTree が呼ばれたときスクロールし、focus: false なら DOM フォーカスは移さない', async () => {
      renderFolderTree('/doc/A/B/C/深い.md', DEEP_TREE_FOR_REVEAL);
      await screen.findByText('A');

      act(() => {
        useUIStore.getState().revealInTree('A/B/C/深い.md');
      });

      const docEl = await screen.findByTestId('doc-A/B/C/深い.md');
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      expect(document.activeElement).not.toBe(docEl);
      expect(useUIStore.getState().revealRequest).toBeNull();
    });

    it('F-3: focus: true の場合、該当行に DOM フォーカスを移す', async () => {
      renderFolderTree('/doc/A/B/C/深い.md', DEEP_TREE_FOR_REVEAL);
      await screen.findByText('A');

      act(() => {
        useUIStore.getState().revealInTree('A/B/C/深い.md', { focus: true });
      });

      const docEl = await screen.findByTestId('doc-A/B/C/深い.md');
      expect(document.activeElement).toBe(docEl);
    });

    it('F-4: フォルダに対する revealInTree(isFolder: true, includeSelf: true) でフォルダ行がスクロール・展開される', async () => {
      renderFolderTree('/doc/A/B/C/深い.md', DEEP_TREE_FOR_REVEAL);
      await screen.findByText('A');

      act(() => {
        useUIStore.getState().revealInTree('A/B', { isFolder: true, includeSelf: true });
      });

      await waitFor(() => {
        const folderBBtn = screen.getByText('B').closest('button');
        expect(folderBBtn).toBeTruthy();
        expect(folderBBtn?.getAttribute('aria-expanded')).toBe('true');
      });
      expect(screen.getByText('C')).toBeTruthy();
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    });

    it('F-5: 存在しないパスの revealInTree では scrollIntoView は呼ばれず要求は破棄される', async () => {
      renderFolderTree('/doc/A/B/C/深い.md', DEEP_TREE_FOR_REVEAL);
      await screen.findByText('A');

      act(() => {
        useUIStore.getState().revealInTree('存在しない/x.md');
      });

      await waitFor(() => {
        expect(useUIStore.getState().revealRequest).toBeNull();
      });
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    });

    it('F-6: tree 応答保留中は revealRequest が残り、resolve 後に scrollIntoView が呼ばれ消費される', async () => {
      let resolveTree!: (v: TreeResponse) => void;
      const treePromise = new Promise<TreeResponse>((r) => {
        resolveTree = r;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          if (url === '/api/tree') {
            return treePromise.then((d) => ({
              ok: true,
              status: 200,
              json: () => Promise.resolve(d),
            }));
          }
          return Promise.resolve({ ok: false, status: 404 });
        }),
      );
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/doc/A/B/C/深い.md']}>
            <Routes>
              <Route path="/doc/*" element={<FolderTree />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      act(() => {
        useUIStore.getState().revealInTree('A/B/C/深い.md');
      });
      expect(useUIStore.getState().revealRequest).not.toBeNull();
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

      await act(async () => {
        resolveTree(DEEP_TREE_FOR_REVEAL);
      });

      await waitFor(() => {
        expect(useUIStore.getState().revealRequest).toBeNull();
      });
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    });

    it('F-7: 利用者がフォルダ A を手動で閉じた後、rerender や tree 再取得でも A は閉じたままで追加スクロールしない', async () => {
      useUIStore.getState().revealInTree('A/B/C/深い.md');
      const { rerender } = renderFolderTree('/doc/A/B/C/深い.md', DEEP_TREE_FOR_REVEAL);
      await screen.findByTestId('doc-A/B/C/深い.md');
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);

      const folderABtn = screen.getByText('A').closest('button')!;
      fireEvent.click(folderABtn);

      await waitFor(() => {
        expect(screen.queryByTestId('doc-A/B/C/深い.md')).toBeNull();
      });

      rerender(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <MemoryRouter initialEntries={['/doc/A/B/C/深い.md']}>
            <Routes>
              <Route path="/doc/*" element={<FolderTree />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      expect(screen.queryByTestId('doc-A/B/C/深い.md')).toBeNull();
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it('F-8: Element.prototype.scrollIntoView が存在しない環境でも例外を投げず要求が消費される', async () => {
      delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
      renderFolderTree('/doc/A/B/C/深い.md', DEEP_TREE_FOR_REVEAL);
      await screen.findByText('A');

      expect(() => {
        act(() => {
          useUIStore.getState().revealInTree('A/B/C/深い.md');
        });
      }).not.toThrow();

      await waitFor(() => {
        expect(useUIStore.getState().revealRequest).toBeNull();
      });
    });

    it('B-1: 追従で focusedPath 設定後に祖先フォルダを手動で閉じても、先頭可視行が tabIndex=0 にフォールバックする', async () => {
      useUIStore.getState().revealInTree('A/B/C/深い.md');
      renderFolderTree('/doc/A/B/C/深い.md', DEEP_TREE_FOR_REVEAL);

      const docEl = await screen.findByTestId('doc-A/B/C/深い.md');
      expect(docEl.tabIndex).toBe(0);

      // フォルダ A をクリックして閉じる
      const folderABtn = screen.getByText('A').closest('button')!;
      fireEvent.click(folderABtn);

      await waitFor(() => {
        expect(screen.queryByTestId('doc-A/B/C/深い.md')).toBeNull();
      });

      // 追従で設定された focusedPath ('A/B/C/深い.md') が非表示になったため、
      // 表示中の先頭行であるフォルダ A に tabIndex=0 がフォールバックすること
      expect(folderABtn.tabIndex).toBe(0);

      // 実際にフォーカスを当ててキー操作できること
      folderABtn.focus();
      expect(document.activeElement).toBe(folderABtn);
    });
  });

  describe('現在の文書をツリーで表示ボタン (#324)', () => {
    const DEEP_TREE_FOR_REVEAL: TreeResponse = {
      folders: ['A', 'A/B', 'A/B/C'],
      docs: [
        {
          path: 'A/B/C/深い.md',
          title: '深い',
          folder: 'A/B/C',
          updatedAt: '2026-07-01T00:00:00+09:00',
        },
      ],
    };

    beforeEach(() => {
      Element.prototype.scrollIntoView = vi.fn();
      useUIStore.setState({
        expandedFolders: new Set(),
        revealRequest: null,
        sidebarTab: 'folder',
      });
    });

    afterEach(() => {
      delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
      useUIStore.setState({
        expandedFolders: new Set(),
        revealRequest: null,
        sidebarTab: 'folder',
      });
    });

    it('T-1: 文書表示中にボタンが表示され有効化されており、アクセシビリティ属性が正しい', async () => {
      renderFolderTree('/doc/A/B/C/深い.md', DEEP_TREE_FOR_REVEAL);
      await screen.findByText('A');

      const btn = screen.getByRole('button', { name: '現在の文書をツリーで表示' });
      expect(btn).toBeTruthy();
      expect((btn as HTMLButtonElement).disabled).toBe(false);
      expect(btn.getAttribute('title')).toBe('現在の文書をツリーで表示');

      const icon = btn.querySelector('svg');
      expect(icon).toBeTruthy();
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
    });

    it('T-2: ボタンをクリックすると祖先が展開され、文書行が表示・ハイライト・スクロール・フォーカスされる', async () => {
      renderFolderTree('/doc/A/B/C/深い.md', DEEP_TREE_FOR_REVEAL);
      await screen.findByText('A');

      // クリック前は展開されていないため文書行は存在しない
      expect(screen.queryByTestId('doc-A/B/C/深い.md')).toBeNull();

      const btn = screen.getByRole('button', { name: '現在の文書をツリーで表示' });
      fireEvent.click(btn);

      const docEl = await screen.findByTestId('doc-A/B/C/深い.md');
      expect(docEl).toBeTruthy();
      expect(docEl.className).toContain('text-accent');
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      expect(document.activeElement).toBe(docEl);
      expect(useUIStore.getState().revealRequest).toBeNull();
    });

    it('T-3: フォルダを閉じた後、再度ボタンを押すと再展開されフォーカスが当たる', async () => {
      renderFolderTree('/doc/A/B/C/深い.md', DEEP_TREE_FOR_REVEAL);
      await screen.findByText('A');

      const btn = screen.getByRole('button', { name: '現在の文書をツリーで表示' });
      fireEvent.click(btn);

      const docEl = await screen.findByTestId('doc-A/B/C/深い.md');
      expect(docEl).toBeTruthy();

      // フォルダ B を閉じる
      const folderBBtn = screen.getByText('B').closest('button')!;
      fireEvent.click(folderBBtn);

      await waitFor(() => {
        expect(screen.queryByTestId('doc-A/B/C/深い.md')).toBeNull();
      });

      // 再度ボタンをクリック
      fireEvent.click(btn);

      const docElReopened = await screen.findByTestId('doc-A/B/C/深い.md');
      expect(docElReopened).toBeTruthy();
      expect(document.activeElement).toBe(docElReopened);
    });

    it('T-4: 文書を開いていないパス(/)ではボタンが disabled', () => {
      renderFolderTree('/', DEEP_TREE_FOR_REVEAL);

      const btn = screen.getByRole('button', {
        name: '現在の文書をツリーで表示',
      }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);

      fireEvent.click(btn);
      expect(useUIStore.getState().revealRequest).toBeNull();
    });

    it('T-5: tree に存在しない文書パスではボタンが disabled', async () => {
      renderFolderTree('/doc/A/B/C/存在しない.md', DEEP_TREE_FOR_REVEAL);
      await screen.findByText('A');

      const btn = screen.getByRole('button', {
        name: '現在の文書をツリーで表示',
      }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    it('T-6: .md が付いていないパスではボタンが disabled', async () => {
      renderFolderTree('/doc/A/B/C/深い', DEEP_TREE_FOR_REVEAL);
      await screen.findByText('A');

      const btn = screen.getByRole('button', {
        name: '現在の文書をツリーで表示',
      }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    it('T-7: tree 取得完了前は disabled で、取得完了後に enabled になる', async () => {
      let resolveTree!: (value: TreeResponse) => void;
      const treePromise = new Promise<TreeResponse>((resolve) => {
        resolveTree = resolve;
      });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          if (url === '/api/tree') {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => treePromise,
            });
          }
          return Promise.resolve({ ok: false, status: 404 });
        }),
      );

      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/doc/A/B/C/深い.md']}>
            <Routes>
              <Route path="/doc/*" element={<FolderTree />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      const btn = screen.getByRole('button', {
        name: '現在の文書をツリーで表示',
      }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);

      await act(async () => {
        resolveTree(DEEP_TREE_FOR_REVEAL);
      });

      await screen.findByText('A');
      expect(btn.disabled).toBe(false);
    });
  });

  describe('添付ファイル表示トグルとプレビュー (#318)', () => {
    const TREE_WITH_ATTACHMENTS: TreeResponse = {
      folders: ['sub'],
      docs: [
        {
          path: 'sub/note.md',
          title: 'サブノート',
          folder: 'sub',
          updatedAt: '2026-07-01T00:00:00+09:00',
        },
        {
          path: 'root.md',
          title: 'ルートノート',
          folder: '',
          updatedAt: '2026-07-01T00:00:00+09:00',
        },
      ],
      attachments: [
        {
          path: 'sub/photo.png',
          name: 'photo.png',
          folder: 'sub',
          updatedAt: '2026-07-01T00:00:00+09:00',
        },
        {
          path: 'diagram.svg',
          name: 'diagram.svg',
          folder: '',
          updatedAt: '2026-07-01T00:00:00+09:00',
        },
        {
          path: 'manual.pdf',
          name: 'manual.pdf',
          folder: '',
          updatedAt: '2026-07-01T00:00:00+09:00',
        },
      ],
    };

    it('AT-04: 初期状態では添付ファイルが非表示で、トグル ON/OFF と localStorage 永続化・再マウント復元ができる', async () => {
      const { unmount } = renderFolderTree('/', TREE_WITH_ATTACHMENTS);
      await screen.findByText('ルートノート');

      const toggleBtn = screen.getByTestId('toggle-attachments');
      expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');
      expect(screen.queryByTestId('attachment-diagram.svg')).toBeNull();
      expect(screen.queryByTestId('attachment-manual.pdf')).toBeNull();

      // ON にするとルート直下の添付が表示される
      fireEvent.click(toggleBtn);
      expect(toggleBtn.getAttribute('aria-pressed')).toBe('true');
      expect(await screen.findByTestId('attachment-diagram.svg')).toBeTruthy();
      expect(screen.getByTestId('attachment-manual.pdf')).toBeTruthy();
      expect(screen.queryByTestId('attachment-sub/photo.png')).toBeNull();

      // サブフォルダを展開すると配下の添付も表示される
      fireEvent.click(screen.getByText('sub'));
      expect(await screen.findByTestId('attachment-sub/photo.png')).toBeTruthy();

      // localStorage に保存され、再マウント後も ON が復元される
      const stored = JSON.parse(localStorage.getItem('tsumiwiki-user-settings') ?? '{}');
      expect(stored.state?.showAttachmentsInTree).toBe(true);

      unmount();
      renderFolderTree('/', TREE_WITH_ATTACHMENTS);
      const remountedToggle = await screen.findByTestId('toggle-attachments');
      expect(remountedToggle.getAttribute('aria-pressed')).toBe('true');
      expect(await screen.findByTestId('attachment-diagram.svg')).toBeTruthy();
      expect(screen.getByTestId('attachment-sub/photo.png')).toBeTruthy();

      // 再度 OFF にすると即座に消える
      fireEvent.click(remountedToggle);
      expect(remountedToggle.getAttribute('aria-pressed')).toBe('false');
      expect(screen.queryByTestId('attachment-diagram.svg')).toBeNull();
      expect(screen.queryByTestId('attachment-sub/photo.png')).toBeNull();
    });

    it('AT-05: 画像(SVG/PNG)・PDF のクリックおよび Enter でライトボックスが開き、Escape で閉じて元の行へフォーカスが戻る', async () => {
      useUserSettingsStore.setState({ showAttachmentsInTree: true });
      useUIStore.setState({ expandedFolders: new Set(['sub']) });
      renderFolderTree('/', TREE_WITH_ATTACHMENTS);

      const svgRow = (await screen.findByTestId('attachment-diagram.svg')) as HTMLButtonElement;
      svgRow.focus();
      fireEvent.click(svgRow);

      const imgDialog = await screen.findByRole('dialog');
      expect(imgDialog.getAttribute('aria-label')).toBe('diagram.svg');
      const img = imgDialog.querySelector('img');
      expect(img?.getAttribute('src')).toBe('/api/files/diagram.svg');

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(svgRow);

      // サブフォルダ内の PNG をクリック
      const pngRow = screen.getByTestId('attachment-sub/photo.png') as HTMLButtonElement;
      pngRow.focus();
      fireEvent.click(pngRow);
      const pngDialog = await screen.findByRole('dialog');
      expect(pngDialog.querySelector('img')?.getAttribute('src')).toBe('/api/files/sub/photo.png');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(pngRow);

      // PDF 行にフォーカスして Enter でプレビュー
      const pdfRow = screen.getByTestId('attachment-manual.pdf') as HTMLButtonElement;
      pdfRow.focus();
      fireEvent.keyDown(pdfRow, { key: 'Enter' });

      const pdfDialog = await screen.findByRole('dialog');
      expect(pdfDialog.getAttribute('aria-label')).toBe('manual.pdf');
      const iframe = pdfDialog.querySelector('iframe');
      expect(iframe?.getAttribute('src')).toBe('/api/files/manual.pdf');

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(pdfRow);
    });

    it('AT-06: 添付行は F2/Delete/ダブルクリック/複数選択/ドラッグを無効化し、専用コンテキストメニューのみ表示する', async () => {
      useUserSettingsStore.setState({ showAttachmentsInTree: true });
      renderFolderTree('/', TREE_WITH_ATTACHMENTS);

      const pdfRow = (await screen.findByTestId('attachment-manual.pdf')) as HTMLButtonElement;
      const docRow = screen.getByTestId('doc-root.md') as HTMLButtonElement;

      // ドラッグ無効
      expect(pdfRow.draggable).toBe(false);

      // F2 / Delete / ダブルクリック でリネーム入力や削除確認ダイアログが開かない
      pdfRow.focus();
      fireEvent.keyDown(pdfRow, { key: 'F2' });
      expect(document.querySelector('input[aria-label="名称変更"]')).toBeNull();

      fireEvent.keyDown(pdfRow, { key: 'Delete' });
      expect(screen.queryByRole('dialog')).toBeNull();

      fireEvent.doubleClick(pdfRow);
      expect(document.querySelector('input[aria-label="名称変更"]')).toBeNull();

      // Ctrl/Shift クリックでも複数選択に混入しない
      fireEvent.click(docRow);
      fireEvent.click(pdfRow, { ctrlKey: true });
      expect(screen.queryByText(/件選択中/)).toBeNull();

      fireEvent.click(pdfRow, { shiftKey: true });
      expect(screen.queryByText(/件選択中/)).toBeNull();

      // 右クリックで「プレビュー」「パスをコピー」のみ表示し、ルートメニューへ伝播しない
      fireEvent.contextMenu(pdfRow, { clientX: 50, clientY: 80 });
      const menu = await screen.findByRole('menu');
      const menuItems = Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
        (el) => el.textContent,
      );
      expect(menuItems).toEqual(['プレビュー', 'パスをコピー']);

      // コンテキストメニューからプレビューを開き、Escape で元の添付行へフォーカス復帰する
      fireEvent.click(screen.getByRole('menuitem', { name: 'プレビュー' }));
      const dialog = await screen.findByRole('dialog');
      expect(dialog.querySelector('iframe')?.getAttribute('src')).toBe('/api/files/manual.pdf');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(pdfRow);
    });
  });
});
