import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DocResponse, SaveDocRequest, User } from '@tsumiwiki/shared';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { docQueryKey, useDoc } from '../api/docs';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { DocView } from './DocView';

const CURRENT_USER: User = {
  id: 1,
  username: 'taro',
  displayName: '太郎',
  role: 'user',
  disabled: false,
};

interface StubOptions {
  putHandler?: (url: string, init?: RequestInit) => Promise<Response> | Response;
  lockHandler?: (url: string, init?: RequestInit) => Promise<Response> | Response;
  getDocHandler?: (url: string, init?: RequestInit) => Promise<Response> | Response;
}

function stubFetch(options: StubOptions = {}) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const [path] = url.split('?');
    const key = `${method} ${path}`;

    if (key === 'GET /api/tags') {
      return Promise.resolve(
        new Response(JSON.stringify({ tags: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    if (key === 'POST /api/locks') {
      if (options.lockHandler) {
        return Promise.resolve(options.lockHandler(url, init));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            lock: { userId: 1, displayName: '太郎', expiresAt: '2026-10-18T00:00:00Z' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    if (method === 'PUT' && path === '/api/docs') {
      if (options.putHandler) {
        return Promise.resolve(options.putHandler(url, init));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            updatedAt: new Date().toISOString(),
            frontmatter: {},
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    if (method === 'GET' && path === '/api/docs') {
      if (options.getDocHandler) {
        return Promise.resolve(options.getDocHandler(url, init));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            path: 'テスト.md',
            frontmatter: {},
            tags: [],
            body: '本文',
            updatedAt: '2026-10-01T10:00:00+09:00',
            lock: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, draft: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function DocViewWrapper({ initialDoc }: { initialDoc: DocResponse }) {
  const { data: doc = initialDoc } = useDoc(initialDoc.path);
  return <DocView doc={doc} currentUser={CURRENT_USER} />;
}

function renderDocView(doc: DocResponse, queryClient?: QueryClient) {
  const qc =
    queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
      },
    });
  qc.setQueryData(docQueryKey(doc.path), doc);
  return {
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/doc/${encodeURIComponent(doc.path)}`]}>
          <Routes>
            <Route
              path="/doc/*"
              element={<DocViewWrapper initialDoc={doc} />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
    queryClient: qc,
  };
}

describe('DocView プロパティ編集結合テスト (DE1〜DE13)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useEditStore.setState({
      mode: 'view',
      dirty: false,
      lockedPath: null,
      lastDraftSavedAt: null,
      saveError: false,
    });
    useToastStore.setState({ toast: null });
  });

  it('DE1: 保存ボタンで ops が送られる（未編集の created は含まれない）', async () => {
    const putBodies: SaveDocRequest[] = [];
    stubFetch({
      putHandler: async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        putBodies.push(body);
        return new Response(
          JSON.stringify({
            updatedAt: '2026-10-17T12:00:00+09:00',
            frontmatter: {
              title: '新',
              created: '2024-01-15T00:00:00.000Z',
              updated: '2026-10-17T12:00:00+09:00',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: {
        title: '旧',
        created: '2024-01-15T00:00:00.000Z',
        updated: '2026-10-01T10:00:00+09:00',
      },
      tags: [],
      body: '本文',
      updatedAt: '2026-10-01T10:00:00+09:00',
      lock: null,
    };

    renderDocView(doc);

    // 編集モード遷移（保存ボタンの出現）を待つ
    const saveBtn = await screen.findByRole('button', { name: '保存' });
    expect(saveBtn.hasAttribute('disabled')).toBe(true);

    // プロパティ展開 → 変更ボタン click
    const toggle = screen.getByRole('button', { name: /プロパティ/ });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('properties-edit'));

    // title を「新」に変更
    const input = screen.getByLabelText('title の値');
    fireEvent.change(input, { target: { value: '新' } });

    // 保存ボタン click
    const activeSaveBtn = screen.getByRole('button', { name: '保存' });
    expect(activeSaveBtn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(activeSaveBtn);

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].frontmatterOps).toEqual([{ op: 'set', key: 'title', value: '新' }]);
  });

  it('DE2: Ctrl+S で入力中の値が送られる', async () => {
    const putBodies: SaveDocRequest[] = [];
    stubFetch({
      putHandler: async (_url, init) => {
        putBodies.push(JSON.parse(init?.body as string));
        return new Response(
          JSON.stringify({
            updatedAt: '2026-10-17T12:00:00+09:00',
            frontmatter: { title: '新しい値' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { title: '旧値' },
      tags: [],
      body: '本文',
      updatedAt: '2026-10-01T10:00:00+09:00',
      lock: null,
    };

    renderDocView(doc);

    await screen.findByRole('button', { name: '保存' });
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const input = screen.getByLabelText('title の値');
    fireEvent.change(input, { target: { value: '新しい値' } });

    // フォーカスしたまま Ctrl+S
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].frontmatterOps).toEqual([{ op: 'set', key: 'title', value: '新しい値' }]);
  });

  it('DE3: dirty とロック: 入力前は保存 disabled・ロック POST なし、1文字入力で保存活性・POST /api/locks', async () => {
    const lockCalls: (RequestInit | undefined)[] = [];
    stubFetch({
      lockHandler: async (_url, init) => {
        lockCalls.push(init);
        return new Response(
          JSON.stringify({
            ok: true,
            lock: { userId: 1, displayName: '太郎', expiresAt: '2026-10-18T00:00:00Z' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { title: '初期値' },
      tags: [],
      body: '本文',
      updatedAt: '2026-10-01T10:00:00+09:00',
      lock: null,
    };

    renderDocView(doc);

    // 初期状態: 保存ボタンは disabled
    const saveBtn = await screen.findByRole('button', { name: '保存' });
    expect(saveBtn.hasAttribute('disabled')).toBe(true);
    expect(lockCalls).toHaveLength(0);

    // 展開して編集
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const input = screen.getByLabelText('title の値');
    fireEvent.change(input, { target: { value: '初期値X' } });

    // 保存ボタンが活性化
    const activeSaveBtn = screen.getByRole('button', { name: '保存' });
    expect(activeSaveBtn.hasAttribute('disabled')).toBe(false);
    await waitFor(() => expect(lockCalls).toHaveLength(1));
  });

  it('DE4: 入力エラーで保存しない（数値型に abc）→ トースト表示、直すと保存できる', async () => {
    const putBodies: SaveDocRequest[] = [];
    stubFetch({
      putHandler: async (_url, init) => {
        putBodies.push(JSON.parse(init?.body as string));
        return new Response(
          JSON.stringify({
            updatedAt: '2026-10-17T12:00:00+09:00',
            frontmatter: { price: 500 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { price: 100 },
      tags: [],
      body: '本文',
      updatedAt: '2026-10-01T10:00:00+09:00',
      lock: null,
    };

    renderDocView(doc);

    await screen.findByRole('button', { name: '保存' });
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const input = screen.getByLabelText('price の値');
    fireEvent.change(input, { target: { value: 'abc' } });

    // 保存ボタン click
    const saveBtn = screen.getByRole('button', { name: '保存' });
    fireEvent.click(saveBtn);

    // PUT は飛ばない
    expect(putBodies).toHaveLength(0);
    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toContain('プロパティに入力エラーがあります');
    });

    // 正しい数値に直す
    fireEvent.change(input, { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].frontmatterOps).toEqual([{ op: 'set', key: 'price', value: 500 }]);
  });

  it('DE5: 保存後に起点が更新される: 保存後の行が更新され、保存ボタンは disabled、続けて変更すると1件だけ送る', async () => {
    let callCount = 0;
    const putBodies: SaveDocRequest[] = [];
    stubFetch({
      putHandler: async (_url, init) => {
        callCount++;
        const body = JSON.parse(init?.body as string);
        putBodies.push(body);
        const nextTitle = callCount === 1 ? '新' : 'さらに新';
        return new Response(
          JSON.stringify({
            updatedAt: `2026-10-17T1${callCount}:00:00+09:00`,
            frontmatter: { title: nextTitle, updated: `2026-10-17T1${callCount}:00:00+09:00` },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { title: '旧', updated: '2026-10-01T10:00:00+09:00' },
      tags: [],
      body: '本文',
      updatedAt: '2026-10-01T10:00:00+09:00',
      lock: null,
    };

    renderDocView(doc);

    await screen.findByRole('button', { name: '保存' });
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const input = screen.getByLabelText('title の値');
    fireEvent.change(input, { target: { value: '新' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: '保存' });
      expect(btn.hasAttribute('disabled')).toBe(true);
    });
    expect(putBodies).toHaveLength(1);

    // 保存後の値が反映されていること
    await waitFor(() => {
      const currentInput = screen.getByLabelText('title の値');
      expect((currentInput as HTMLInputElement).value).toBe('新');
    });

    // 続けてさらに新に変更
    const newInput = screen.getByLabelText('title の値');
    fireEvent.change(newInput, { target: { value: 'さらに新' } });
    const activeSaveBtn = screen.getByRole('button', { name: '保存' });
    expect(activeSaveBtn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(activeSaveBtn);

    await waitFor(() => expect(putBodies).toHaveLength(2));
    expect(putBodies[1].frontmatterOps).toEqual([{ op: 'set', key: 'title', value: 'さらに新' }]);
  });

  it('DE6: 400 FRONTMATTER_INVALID: トーストに message、dirty のまま、入力値は残る', async () => {
    stubFetch({
      putHandler: async () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'FRONTMATTER_INVALID',
              message: 'アンカーを含むキーは編集できません',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { title: '旧' },
      tags: [],
      body: '本文',
      updatedAt: '2026-10-01T10:00:00+09:00',
      lock: null,
    };

    renderDocView(doc);

    await screen.findByRole('button', { name: '保存' });
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const input = screen.getByLabelText('title の値');
    fireEvent.change(input, { target: { value: '変更値' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toContain('アンカーを含むキーは編集できません');
    });

    const saveBtn = screen.getByRole('button', { name: '保存' });
    expect(saveBtn.hasAttribute('disabled')).toBe(false);
    expect((input as HTMLInputElement).value).toBe('変更値');
  });

  it('DE7: 破棄で元に戻る: 値変更 → 破棄 → 確認 OK で元の値に戻る', async () => {
    stubFetch();
    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { title: '元のタイトル' },
      tags: [],
      body: '本文',
      updatedAt: '2026-10-01T10:00:00+09:00',
      lock: null,
    };

    renderDocView(doc);

    await screen.findByRole('button', { name: '保存' });
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const input = screen.getByLabelText('title の値');
    fireEvent.change(input, { target: { value: '書き換え中' } });

    // 破棄ボタン click
    const discardBtn = screen.getByRole('button', { name: '破棄' });
    fireEvent.click(discardBtn);

    // 確認ダイアログの「破棄」click（ダイアログ内のボタン）
    const discardBtns = await screen.findAllByRole('button', { name: '破棄' });
    fireEvent.click(discardBtns[discardBtns.length - 1]);

    // 閲覧モードになり、プロパティフォームは消える
    await waitFor(() => {
      expect(screen.queryByTestId('properties-editor')).toBeNull();
      expect(screen.getByText('閲覧モード')).toBeTruthy();
    });

    // パネルが閉じていれば開く
    const propToggle = screen.getByRole('button', { name: /プロパティ/ });
    if (propToggle.getAttribute('aria-expanded') !== 'true') {
      fireEvent.click(propToggle);
    }
    await waitFor(() => {
      expect(screen.getByText('元のタイトル')).toBeTruthy();
    });

    // 「✎ 編集」を押して再編集に入ると、入力欄も元の値
    fireEvent.click(screen.getByRole('button', { name: /編集/ }));
    await screen.findByRole('button', { name: '保存' });
    fireEvent.click(screen.getByTestId('properties-edit'));
    const reInput = screen.getByLabelText('title の値');
    expect((reInput as HTMLInputElement).value).toBe('元のタイトル');
  });

  it('DE8: ソース編集中も編集できる: ソース切替後もプロパティ編集可能で両方送られる', async () => {
    const putBodies: SaveDocRequest[] = [];
    stubFetch({
      putHandler: async (_url, init) => {
        putBodies.push(JSON.parse(init?.body as string));
        return new Response(
          JSON.stringify({
            updatedAt: '2026-10-17T12:00:00+09:00',
            frontmatter: { title: 'ソースモードで更新' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { title: '旧タイトル' },
      tags: [],
      body: '本文',
      updatedAt: '2026-10-01T10:00:00+09:00',
      lock: null,
    };

    renderDocView(doc);

    await screen.findByRole('button', { name: '保存' });

    // エディタをクリックしてツールバーを表示
    const proseMirror = document.querySelector('.ProseMirror') as HTMLElement;
    fireEvent.click(proseMirror);

    // ソース編集モード切替
    const sourceToggle = await screen.findByRole('button', { name: /ソース/ });
    fireEvent.click(sourceToggle);

    const sourceEditor = screen.getByTestId('source-editor');
    expect(sourceEditor).toBeTruthy();
    fireEvent.change(sourceEditor, { target: { value: '本文に追記' } });

    // プロパティを展開・編集
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const propInput = screen.getByLabelText('title の値');
    fireEvent.change(propInput, { target: { value: 'ソースモードで更新' } });

    // 保存
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].body).toBe('本文に追記');
    expect(putBodies[0].frontmatterOps).toEqual([
      { op: 'set', key: 'title', value: 'ソースモードで更新' },
    ]);
  });

  it('DE9: Ctrl+K ガード: プロパティ入力欄で Ctrl+K を押してもリンクダイアログは開かない', async () => {
    stubFetch();
    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { title: 'テスト' },
      tags: [],
      body: '本文',
      updatedAt: '2026-10-01T10:00:00+09:00',
      lock: null,
    };

    renderDocView(doc);

    await screen.findByRole('button', { name: '保存' });
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const propInput = screen.getByLabelText('title の値');
    propInput.focus();

    // プロパティ欄内で Ctrl+K
    fireEvent.keyDown(propInput, { key: 'k', ctrlKey: true });

    expect(screen.queryByTestId('link-dialog')).toBeNull();
  });

  it('DE10: 本文とプロパティの同時保存: 保存 1 回で body と ops が送られる', async () => {
    const putBodies: SaveDocRequest[] = [];
    stubFetch({
      putHandler: async (_url, init) => {
        putBodies.push(JSON.parse(init?.body as string));
        return new Response(
          JSON.stringify({
            updatedAt: '2026-10-17T12:00:00+09:00',
            frontmatter: { title: '新タイトル' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { title: '旧タイトル' },
      tags: [],
      body: '本文',
      updatedAt: '2026-10-01T10:00:00+09:00',
      lock: null,
    };

    renderDocView(doc);

    await screen.findByRole('button', { name: '保存' });

    // 本文変更（ソースモードで行うとシンプルかつ確実）
    const proseMirror = document.querySelector('.ProseMirror') as HTMLElement;
    fireEvent.click(proseMirror);
    const sourceToggle = await screen.findByRole('button', { name: /ソース/ });
    fireEvent.click(sourceToggle);
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: '更新本文' } });

    // プロパティ変更
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));
    fireEvent.change(screen.getByLabelText('title の値'), { target: { value: '新タイトル' } });

    // 保存
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].body).toBe('更新本文');
    expect(putBodies[0].frontmatterOps).toEqual([
      { op: 'set', key: 'title', value: '新タイトル' },
    ]);
  });

  it('DE11: 本文だけ dirty の間は行を作り直さない', async () => {
    stubFetch();
    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { title: '初期タイトル' },
      tags: [],
      body: '本文',
      updatedAt: '2026-10-01T10:00:00+09:00',
      lock: null,
    };

    const { queryClient } = renderDocView(doc);

    await screen.findByRole('button', { name: '保存' });

    // プロパティを変更
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));
    const input = screen.getByLabelText('title の値');
    fireEvent.change(input, { target: { value: '未保存の変更値' } });

    // キャッシュの doc.frontmatter を外部更新で差し替える
    queryClient.setQueryData(docQueryKey('テスト.md'), {
      ...doc,
      frontmatter: { title: '外部からの更新' },
    });

    // 入力値は上書きされず維持されていること
    expect((input as HTMLInputElement).value).toBe('未保存の変更値');
  });

  it('DE12: 他者ロック中: 閲覧モードで #281 の表示のみ、properties-editor が無い', async () => {
    stubFetch();
    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { title: 'ロック中文書' },
      tags: [],
      body: '本文',
      updatedAt: '2026-10-01T10:00:00+09:00',
      lock: { userId: 2, displayName: '花子' },
    };

    renderDocView(doc);

    expect(await screen.findByText('花子さんが編集中')).toBeTruthy();
    expect(screen.getByText('閲覧モード')).toBeTruthy();

    const toggle = screen.getByRole('button', { name: /プロパティ/ });
    fireEvent.click(toggle);

    expect(screen.getByTestId('properties-list')).toBeTruthy();
    expect(screen.queryByTestId('properties-editor')).toBeNull();
    expect(screen.queryByTestId('properties-edit')).toBeNull();
  });

  it('DE13: 送信中の入力が残る: PUT 待機中に追加入力 → PUT 解決後も最後の値が維持され dirty=true', async () => {
    let resolvePut: (value: Response) => void;
    const putPromise = new Promise<Response>((resolve) => {
      resolvePut = resolve;
    });

    const putBodies: SaveDocRequest[] = [];
    stubFetch({
      putHandler: async (_url, init) => {
        putBodies.push(JSON.parse(init?.body as string));
        if (putBodies.length === 1) {
          return putPromise;
        }
        return new Response(
          JSON.stringify({
            updatedAt: '2026-10-17T13:00:00+09:00',
            frontmatter: { title: '最後の値' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { title: '初期値' },
      tags: [],
      body: '本文',
      updatedAt: '2026-10-01T10:00:00+09:00',
      lock: null,
    };

    renderDocView(doc);

    await screen.findByRole('button', { name: '保存' });
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const input = screen.getByLabelText('title の値');
    fireEvent.change(input, { target: { value: '第1の変更' } });

    // 保存ボタン click → PUT 送信待機中
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(putBodies).toHaveLength(1));

    // 送信中に追加入力
    fireEvent.change(input, { target: { value: '最後の値' } });

    // PUT を解決
    resolvePut!(
      new Response(
        JSON.stringify({
          updatedAt: '2026-10-17T12:00:00+09:00',
          frontmatter: { title: '第1の変更' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    // 1回目の完了（トースト通知）を待つ
    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe('保存しました');
    });

    // 入力欄は「最後の値」のまま、保存ボタンは活性（dirty 維持）
    expect((input as HTMLInputElement).value).toBe('最後の値');
    const saveBtn = screen.getByRole('button', { name: '保存' });
    expect(saveBtn.hasAttribute('disabled')).toBe(false);

    // 再度保存 click → 2回目の PUT に「最後の値」が載る
    fireEvent.click(saveBtn);

    await waitFor(() => expect(putBodies).toHaveLength(2));
    expect(putBodies[1].frontmatterOps).toEqual([{ op: 'set', key: 'title', value: '最後の値' }]);
  });
});
