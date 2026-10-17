import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DocResponse, User } from '@tsumiwiki/shared';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainPage } from '../pages/MainPage';
import { useEditStore } from '../stores/edit';
import { useTabsStore } from '../stores/tabs';
import { useUIStore } from '../stores/ui';
import { useUserSettingsStore } from '../stores/user-settings';
import { AppShell } from './AppShell';

const USER: User = {
  id: 1,
  username: 'taro',
  displayName: '太郎',
  role: 'user',
  disabled: false,
};

const INITIAL_DOC_A: DocResponse = {
  path: 'A文書.md',
  body: 'A文書の本文',
  tags: ['重要'],
  frontmatter: {
    tags: ['重要'],
    title: 'A文書タイトル',
    price: 980,
    updated: '2026-10-17T01:00:00.000Z',
  },
  updatedAt: '2026-10-17T01:00:00.000Z',
  lock: null,
};

const INITIAL_DOC_B: DocResponse = {
  path: 'B文書.md',
  body: 'B文書の本文',
  tags: [],
  frontmatter: {},
  updatedAt: '2026-10-17T02:00:00.000Z',
  lock: null,
};

const INITIAL_DOC_C: DocResponse = {
  path: 'C文書.md',
  body: 'C文書の本文',
  tags: [],
  frontmatter: {
    category: 'テストC',
  },
  updatedAt: '2026-10-17T03:00:00.000Z',
  lock: null,
};

interface PutDocResult {
  status?: number;
  json?: Record<string, unknown>;
  updatedAt?: string;
  frontmatter?: Record<string, unknown>;
}

describe('PropertiesPanel 統合テスト (I1〜I10)', () => {
  let docsDb: Record<string, DocResponse>;
  let putDocHandler: ((body: Record<string, unknown>) => PutDocResult) | null = null;
  let activeQueryClient: QueryClient | null = null;

  beforeEach(() => {
    localStorage.clear();
    useTabsStore.getState().reset();
    useEditStore.setState({ mode: 'view', dirty: false, lockedPath: null, lastDraftSavedAt: null, saveError: false });
    useUserSettingsStore.setState({
      rightPanelOpen: false,
      rightPanelWidth: 320,
    });
    useUIStore.setState({
      sidebarCollapsed: false,
    });

    docsDb = {
      'A文書.md': JSON.parse(JSON.stringify(INITIAL_DOC_A)),
      'B文書.md': JSON.parse(JSON.stringify(INITIAL_DOC_B)),
      'C文書.md': JSON.parse(JSON.stringify(INITIAL_DOC_C)),
    };
    putDocHandler = null;

    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const urlObj = new URL(url, 'http://localhost');
        const pathname = urlObj.pathname;
        const queryPath = urlObj.searchParams.get('path');
        const method = (init?.method ?? 'GET').toUpperCase();

        if (pathname === '/api/auth/me') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ user: USER }),
          });
        }
        if (pathname === '/api/tree') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                folders: [],
                docs: Object.values(docsDb).map((d) => ({
                  path: d.path,
                  title: d.path.replace(/\.md$/, ''),
                  folder: '',
                  updatedAt: d.updatedAt,
                })),
              }),
          });
        }
        if (pathname === '/api/docs/recent') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ docs: [] }) });
        }
        if (pathname === '/api/docs' && method === 'GET') {
          const doc = queryPath && docsDb[queryPath];
          if (doc) {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(doc) });
          }
          return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'Not found' }) });
        }
        if (pathname === '/api/docs' && method === 'PUT') {
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
          if (putDocHandler) {
            const handled = putDocHandler(body);
            if (handled.status && handled.status !== 200) {
              return Promise.resolve({
                ok: false,
                status: handled.status,
                json: () => Promise.resolve(handled.json ?? { error: { code: 'CONFLICT', message: '競合' } }),
              });
            }
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(handled),
            });
          }
          const newUpdatedAt = '2026-10-17T10:00:00.000Z';
          const newFm = {
            ...docsDb[body.path]?.frontmatter,
            updated: newUpdatedAt,
          };
          if (docsDb[body.path]) {
            docsDb[body.path].updatedAt = newUpdatedAt;
            docsDb[body.path].frontmatter = newFm;
            docsDb[body.path].body = body.body;
            if (body.tags) docsDb[body.path].tags = body.tags;
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                updatedAt: newUpdatedAt,
                frontmatter: newFm,
              }),
          });
        }
        if (pathname === '/api/locks') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
        }
        if (pathname === '/api/drafts') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, draft: null }) });
        }
        if (pathname === '/api/tags') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ tags: [] }) });
        }
        if (pathname === '/api/docs/backlinks') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ backlinks: [], truncated: false }),
          });
        }
        if (pathname === '/api/history' || pathname === '/api/history/all') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ history: [] }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useTabsStore.getState().reset();
  });

  function renderApp(initialEntries = ['/doc/A文書.md']) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    activeQueryClient = queryClient;
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<MainPage />} />
              <Route path="doc/*" element={<MainPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('I1: 文書オープン時の初期状態は折りたたみ表示（件数表示、値は非表示）', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });

    const button = await screen.findByRole('button', { name: /プロパティ/ });
    // tags は除外され title, price, updated の3件
    expect(button.textContent).toContain('プロパティ (3件)');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('A文書タイトル')).toBeNull();
  });

  it('I2: 空のフロントマターを持つ文書ではパネルが一切描画されない', async () => {
    renderApp(['/doc/B文書.md']);
    await screen.findByRole('heading', { name: 'B文書' });

    expect(screen.queryByTestId('properties-panel')).toBeNull();
  });

  it('I3: タブ切替を行っても各タブのプロパティ開閉状態が独立して維持される', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });

    // A文書のプロパティを展開
    const tabContainerA = await screen.findByTestId(/doctab-A文書\.md/);
    const buttonA = within(tabContainerA).getByRole('button', { name: /プロパティ/ });
    fireEvent.click(buttonA);
    expect(within(tabContainerA).getByText('A文書タイトル')).toBeTruthy();
    expect(buttonA.getAttribute('aria-expanded')).toBe('true');

    // C文書を開く（tabsStoreから固定タブとして追加）
    useTabsStore.getState().openDoc('C文書.md', { pinned: true });
    const tabContainerC = await screen.findByTestId(/doctab-C文書\.md/);

    // C文書のプロパティは初期状態で折りたたみ
    const buttonC = await within(tabContainerC).findByRole('button', { name: /プロパティ/ });
    expect(buttonC.getAttribute('aria-expanded')).toBe('false');

    // A文書のタブへ切り替え戻す
    useTabsStore.getState().setActive('A文書.md');

    // A文書のプロパティは開いたまま維持されている
    expect(within(tabContainerA).getByText('A文書タイトル')).toBeTruthy();
    expect(buttonA.getAttribute('aria-expanded')).toBe('true');
  });

  it('I4: タブを閉じて再度開いた場合はインスタンスが再生成され折りたたみ状態にリセットされる', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });

    // A文書のプロパティを展開
    const tabContainerA = await screen.findByTestId(/doctab-A文書\.md/);
    const buttonA = within(tabContainerA).getByRole('button', { name: /プロパティ/ });
    fireEvent.click(buttonA);
    expect(within(tabContainerA).getByText('A文書タイトル')).toBeTruthy();

    // A文書タブを閉じる
    useTabsStore.getState().closeTab('A文書.md');
    await waitFor(() => {
      expect(screen.queryByTestId(/doctab-A文書\.md/)).toBeNull();
    });

    // 再度 A文書を開く
    useTabsStore.getState().openDoc('A文書.md', { pinned: true });
    const newContainerA = await screen.findByTestId(/doctab-A文書\.md/);

    // 新規マウントされたので閉じた状態に戻っている
    const newButton = within(newContainerA).getByRole('button', { name: /プロパティ/ });
    expect(newButton.getAttribute('aria-expanded')).toBe('false');
    expect(within(newContainerA).queryByText('A文書タイトル')).toBeNull();
  });

  it('I5: preview タブで別文書に置換後、元の文書を再度開いた場合もリセットされる', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });

    // preview タブとして A文書を開いた状態で展開
    const buttonA = await screen.findByRole('button', { name: /プロパティ/ });
    fireEvent.click(buttonA);
    expect(screen.getByText('A文書タイトル')).toBeTruthy();

    // 同じプレビュースロットで C文書に置換
    useTabsStore.getState().openDoc('C文書.md');
    await screen.findByRole('heading', { name: 'C文書' });

    // 再度 A文書をプレビューで開く（同一スロット置換）
    useTabsStore.getState().openDoc('A文書.md');
    await screen.findByRole('heading', { name: 'A文書' });

    // 再マウントされたため閉じた状態になっている
    const buttonReset = await screen.findByRole('button', { name: /プロパティ/ });
    expect(buttonReset.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('A文書タイトル')).toBeNull();
  });

  it('I6: 閲覧モードのキャッシュ更新（refetch）時も展開状態を維持し新値に更新される', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });

    // 展開する
    const button = await screen.findByRole('button', { name: /プロパティ/ });
    fireEvent.click(button);
    expect(screen.getByText('A文書タイトル')).toBeTruthy();

    // QueryClient経由でキャッシュデータを更新（refetchシミュレーション）
    activeQueryClient?.setQueryData<DocResponse>(['doc', 'A文書.md'], (old) =>
      old
        ? {
            ...old,
            frontmatter: {
              ...old.frontmatter,
              title: '更新された新タイトル',
            },
          }
        : old,
    );

    // 展開されたまま新タイトルが表示される
    await screen.findByText('更新された新タイトル');
    expect(screen.getByRole('button', { name: /プロパティ/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('I7: 保存ボタンクリックでサーバーが返した新frontmatter（updated等）が即時反映される', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });

    // プロパティを展開
    const toggleBtn = await screen.findByRole('button', { name: /プロパティ/ });
    fireEvent.click(toggleBtn);
    expect(screen.getByText('2026/10/17 10:00')).toBeTruthy();

    // 保存ボタンを待つ
    const saveBtn = await screen.findByRole('button', { name: /保存/ });

    // PUT のレスポンスをカスタマイズ（新しい updated）
    putDocHandler = (_body) => {
      return {
        updatedAt: '2026-10-17T03:30:00.000Z',
        frontmatter: {
          ...INITIAL_DOC_A.frontmatter,
          updated: '2026-10-17T03:30:00.000Z',
        },
      };
    };

    // タグ削除で dirty にして保存可能にする
    fireEvent.click(screen.getByRole('button', { name: 'タグ #重要 を削除' }));
    expect(saveBtn.hasAttribute('disabled')).toBe(false);

    // 保存実行
    fireEvent.click(saveBtn);

    // updated が JST 12:30 (03:30Z) に更新されていること
    await screen.findByText('2026/10/17 12:30');
    expect(screen.getByRole('button', { name: /プロパティ/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('I8: 古いサーバーで PUT 応答に frontmatter が含まれない場合も既存値が維持される（後方互換）', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });

    const toggleBtn = await screen.findByRole('button', { name: /プロパティ/ });
    fireEvent.click(toggleBtn);
    expect(screen.getByText('A文書タイトル')).toBeTruthy();

    const saveBtn = await screen.findByRole('button', { name: /保存/ });

    // 古いサーバーのように frontmatter キーを返さない
    putDocHandler = () => {
      return {
        updatedAt: '2026-10-17T05:00:00.000Z',
      };
    };

    fireEvent.click(screen.getByRole('button', { name: 'タグ #重要 を削除' }));
    fireEvent.click(saveBtn);

    // 保存成功後も、既存の frontmatter（A文書タイトル）が壊れず表示されたままであること
    await waitFor(() => {
      expect(saveBtn.hasAttribute('disabled')).toBe(true);
    });
    expect(screen.getByText('A文書タイトル')).toBeTruthy();
  });

  it('I9: 競合発生後の「上書き保存」でも返ってきた新frontmatterが反映される', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });

    const toggleBtn = await screen.findByRole('button', { name: /プロパティ/ });
    fireEvent.click(toggleBtn);

    const saveBtn = await screen.findByRole('button', { name: /保存/ });

    // 1回目の保存は 409 競合
    let saveCount = 0;
    putDocHandler = (_body) => {
      saveCount++;
      if (saveCount === 1) {
        return { status: 409, json: { error: { code: 'CONFLICT', message: '競合が発生しました' } } };
      }
      return {
        updatedAt: '2026-10-17T08:00:00.000Z',
        frontmatter: {
          ...INITIAL_DOC_A.frontmatter,
          updated: '2026-10-17T08:00:00.000Z',
        },
      };
    };

    // dirty にして保存
    fireEvent.click(screen.getByRole('button', { name: 'タグ #重要 を削除' }));
    fireEvent.click(saveBtn);

    // 競合ダイアログが表示されるのを待つ
    const overwriteBtn = await screen.findByRole('button', { name: '自分の内容で上書き保存' });

    // 上書き保存を実行
    fireEvent.click(overwriteBtn);

    // updated が JST 17:00 (08:00Z) に更新されること
    await screen.findByText('2026/10/17 17:00');
  });

  it('I10: タグチップエディタでのタグ追加・削除操作とプロパティパネルが干渉しない', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });

    const toggleBtn = await screen.findByRole('button', { name: /プロパティ/ });
    // パネルの件数は tags を除外した 3 件
    expect(toggleBtn.textContent).toContain('プロパティ (3件)');

    // タグを削除
    fireEvent.click(screen.getByRole('button', { name: 'タグ #重要 を削除' }));

    // プロパティパネルの件数は 3 件のままで変化しない
    expect(toggleBtn.textContent).toContain('プロパティ (3件)');

    // パネルを展開しても tags 行は存在しない
    fireEvent.click(toggleBtn);
    expect(screen.queryByTitle('tags')).toBeNull();
  });
});
