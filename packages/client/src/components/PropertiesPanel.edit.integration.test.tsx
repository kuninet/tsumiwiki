import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DocResponse, SaveDocRequest, User } from '@tsumiwiki/shared';
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
  frontmatter: {
    category: 'テストB',
  },
  updatedAt: '2026-10-17T02:00:00.000Z',
  lock: null,
};

interface PutDocResult {
  status?: number;
  json?: Record<string, unknown>;
  updatedAt?: string;
  frontmatter?: Record<string, unknown>;
}

describe('PropertiesPanel 編集統合テスト (IE1〜IE8)', () => {
  let docsDb: Record<string, DocResponse>;
  let putDocHandler: ((body: Record<string, unknown>) => PutDocResult | null) | null = null;
  let recordedPuts: SaveDocRequest[] = [];

  beforeEach(() => {
    localStorage.clear();
    useTabsStore.getState().reset();
    useEditStore.setState({
      mode: 'view',
      dirty: false,
      lockedPath: null,
      lastDraftSavedAt: null,
      saveError: false,
    });
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
    };
    putDocHandler = null;
    recordedPuts = [];

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
          recordedPuts.push(body);
          if (putDocHandler) {
            const handled = putDocHandler(body);
            if (handled) {
              if (handled.status && handled.status !== 200) {
                return Promise.resolve({
                  ok: false,
                  status: handled.status,
                  json: () =>
                    Promise.resolve(handled.json ?? { error: { code: 'CONFLICT', message: '競合' } }),
                });
              }
              return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve(handled),
              });
            }
          }
          const newUpdatedAt = `2026-10-17T1${recordedPuts.length}:00:00.000Z`;
          const newFm = { ...docsDb[body.path]?.frontmatter };
          if (body.frontmatterOps) {
            for (const op of body.frontmatterOps) {
              if (op.op === 'set') {
                newFm[op.key] = op.value;
              } else if (op.op === 'delete') {
                delete newFm[op.key];
              } else if (op.op === 'rename') {
                const val = newFm[op.from];
                delete newFm[op.from];
                newFm[op.to] = val;
              }
            }
          }
          newFm.updated = newUpdatedAt;
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
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity } },
    });
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

  it('IE1: タブ切替で未保存の入力が残る: A で title を編集（未保存）→ B タブへ → A に戻る → 入力値と開閉が残り、A タブの dirty 表示も残る', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });

    const tabContainerA = await screen.findByTestId(/doctab-A文書\.md/);
    await within(tabContainerA).findByRole('button', { name: '保存' });

    // A文書のプロパティを展開して編集フォームを開く
    const propToggleA = within(tabContainerA).getByRole('button', { name: /プロパティ/ });
    fireEvent.click(propToggleA);
    fireEvent.click(within(tabContainerA).getByTestId('properties-edit'));

    // title を変更
    const inputTitleA = within(tabContainerA).getByLabelText('title の値');
    fireEvent.change(inputTitleA, { target: { value: 'Aタイトル更新中' } });

    // A文書が dirty になっていることを確認
    const saveBtnA = within(tabContainerA).getByRole('button', { name: '保存' });
    expect(saveBtnA.hasAttribute('disabled')).toBe(false);

    // B文書を開く
    useTabsStore.getState().openDoc('B文書.md', { pinned: true });
    const tabContainerB = await screen.findByTestId(/doctab-B文書\.md/);
    await within(tabContainerB).findByRole('heading', { name: 'B文書' });

    // A文書へ切り替え戻す
    useTabsStore.getState().setActive('A文書.md');

    // A文書の入力値と編集フォームが残り、保存ボタンも活性（dirty）のまま
    expect(within(tabContainerA).getByTestId('properties-editor')).toBeTruthy();
    const currentInputA = within(tabContainerA).getByLabelText('title の値');
    expect((currentInputA as HTMLInputElement).value).toBe('Aタイトル更新中');
    expect(within(tabContainerA).getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(false);
  });

  it('IE2: タブ間で独立: A を編集中に B を開いて B の値を編集 → それぞれの保存で各文書の ops だけが送られる', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });
    const tabContainerA = await screen.findByTestId(/doctab-A文書\.md/);
    await within(tabContainerA).findByRole('button', { name: '保存' });

    // A文書で title を変更
    fireEvent.click(within(tabContainerA).getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(within(tabContainerA).getByTestId('properties-edit'));
    fireEvent.change(within(tabContainerA).getByLabelText('title の値'), { target: { value: 'タイトルA新' } });

    // B文書を開く
    useTabsStore.getState().openDoc('B文書.md', { pinned: true });
    const tabContainerB = await screen.findByTestId(/doctab-B文書\.md/);
    await within(tabContainerB).findByRole('heading', { name: 'B文書' });
    await within(tabContainerB).findByRole('button', { name: '保存' });

    // B文書で category を変更
    fireEvent.click(within(tabContainerB).getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(within(tabContainerB).getByTestId('properties-edit'));
    fireEvent.change(within(tabContainerB).getByLabelText('category の値'), { target: { value: 'カテゴリB新' } });

    // B文書を保存
    fireEvent.click(within(tabContainerB).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(recordedPuts).toHaveLength(1));
    expect(recordedPuts[0].path).toBe('B文書.md');
    expect(recordedPuts[0].frontmatterOps).toEqual([{ op: 'set', key: 'category', value: 'カテゴリB新' }]);

    // A文書へ切り替え戻して保存
    useTabsStore.getState().setActive('A文書.md');
    fireEvent.click(within(tabContainerA).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(recordedPuts).toHaveLength(2));
    expect(recordedPuts[1].path).toBe('A文書.md');
    expect(recordedPuts[1].frontmatterOps).toEqual([{ op: 'set', key: 'title', value: 'タイトルA新' }]);
  });

  it('IE3: dirty なタブを閉じる: プロパティだけ変更した A を閉じる → CloseConfirmDialog が出る →「保存して閉じる」で PUT に ops', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });
    const tabContainerA = await screen.findByTestId(/doctab-A文書\.md/);
    await within(tabContainerA).findByRole('button', { name: '保存' });

    // A文書で title を変更
    fireEvent.click(within(tabContainerA).getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(within(tabContainerA).getByTestId('properties-edit'));
    fireEvent.change(within(tabContainerA).getByLabelText('title の値'), { target: { value: '保存して閉じるタイトル' } });

    // タブの「×」ボタンを押す
    const closeBtn = screen.getByTestId('tab-close-A文書.md');
    fireEvent.click(closeBtn);

    // 未保存確認ダイアログが表示される
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('未保存の変更があります')).toBeTruthy();

    // 「保存して閉じる」ボタンをクリック
    const saveAndCloseBtn = within(dialog).getByRole('button', { name: '保存して閉じる' });
    fireEvent.click(saveAndCloseBtn);

    // PUT が呼ばれ、frontmatterOps が送られたこと
    await waitFor(() => expect(recordedPuts).toHaveLength(1));
    expect(recordedPuts[0].path).toBe('A文書.md');
    expect(recordedPuts[0].frontmatterOps).toEqual([{ op: 'set', key: 'title', value: '保存して閉じるタイトル' }]);

    // タブが閉じられたこと
    await waitFor(() => {
      expect(screen.queryByTestId('tab-A文書.md')).toBeNull();
    });
  });

  it('IE4: 競合 → 上書き保存: 1回目の PUT が 409 → 競合ダイアログ「自分の内容で上書き保存」→ 2回目の PUT にも同じ ops が載る', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });
    const tabContainerA = await screen.findByTestId(/doctab-A文書\.md/);
    await within(tabContainerA).findByRole('button', { name: '保存' });

    // title を変更
    fireEvent.click(within(tabContainerA).getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(within(tabContainerA).getByTestId('properties-edit'));
    fireEvent.change(within(tabContainerA).getByLabelText('title の値'), { target: { value: '上書き保存値' } });

    // 1回目は 409 競合を返すハンドラを設定
    let saveCount = 0;
    putDocHandler = (_body) => {
      saveCount++;
      if (saveCount === 1) {
        return { status: 409, json: { error: { code: 'CONFLICT', message: '競合が発生しました' } } };
      }
      return null; // 通常の正常処理
    };

    // 保存ボタン click
    fireEvent.click(within(tabContainerA).getByRole('button', { name: '保存' }));

    // 競合ダイアログが表示される
    const overwriteBtn = await screen.findByRole('button', { name: '自分の内容で上書き保存' });
    expect(overwriteBtn).toBeTruthy();

    // 上書き保存を実行
    fireEvent.click(overwriteBtn);

    // 2回目の PUT にも同じ ops が載っていること
    await waitFor(() => expect(recordedPuts).toHaveLength(2));
    expect(recordedPuts[0].frontmatterOps).toEqual([{ op: 'set', key: 'title', value: '上書き保存値' }]);
    expect(recordedPuts[1].frontmatterOps).toEqual([{ op: 'set', key: 'title', value: '上書き保存値' }]);
  });

  it('IE5: 競合 → 破棄: 409 → 「破棄して最新を読み込む」→ 最新の docsDb の frontmatter が閲覧表示される', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });
    const tabContainerA = await screen.findByTestId(/doctab-A文書\.md/);
    await within(tabContainerA).findByRole('button', { name: '保存' });

    // title を変更
    fireEvent.click(within(tabContainerA).getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(within(tabContainerA).getByTestId('properties-edit'));
    fireEvent.change(within(tabContainerA).getByLabelText('title の値'), { target: { value: '破棄されるタイトル' } });

    // 409 競合
    putDocHandler = (_body) => {
      return { status: 409, json: { error: { code: 'CONFLICT', message: '競合' } } };
    };

    // 保存ボタン click
    fireEvent.click(within(tabContainerA).getByRole('button', { name: '保存' }));

    // 競合ダイアログが表示される
    const discardBtn = await screen.findByRole('button', { name: '破棄して最新を読み込む' });

    // サーバー側の最新状態を docsDb に仕込む
    docsDb['A文書.md'].frontmatter = {
      title: 'サーバー側の最新タイトル',
      updated: '2026-10-17T09:00:00.000Z',
    };
    docsDb['A文書.md'].updatedAt = '2026-10-17T09:00:00.000Z';

    // 破棄をクリック
    fireEvent.click(discardBtn);

    // 閲覧モードになり、最新の frontmatter が表示される
    await waitFor(() => {
      expect(screen.queryByTestId('properties-editor')).toBeNull();
      expect(within(tabContainerA).getAllByText('閲覧モード').length).toBeGreaterThan(0);
    });

    const toggleBtn = within(tabContainerA).getByRole('button', { name: /プロパティ/ });
    if (toggleBtn.getAttribute('aria-expanded') !== 'true') {
      fireEvent.click(toggleBtn);
    }
    await waitFor(() => {
      expect(within(tabContainerA).getByText('サーバー側の最新タイトル')).toBeTruthy();
    });
  });

  it('IE6: 保存後に再オープン: 保存 → タブを閉じる → 開き直す → 新しい値が初期折りたたみで見える（GET の値）', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });
    const tabContainerA = await screen.findByTestId(/doctab-A文書\.md/);
    await within(tabContainerA).findByRole('button', { name: '保存' });

    // title を変更して保存
    fireEvent.click(within(tabContainerA).getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(within(tabContainerA).getByTestId('properties-edit'));
    fireEvent.change(within(tabContainerA).getByLabelText('title の値'), { target: { value: '保存された新タイトル' } });
    fireEvent.click(within(tabContainerA).getByRole('button', { name: '保存' }));

    // 保存完了（disabled に戻る）を待つ
    await waitFor(() => {
      expect(within(tabContainerA).getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true);
    });

    // タブを閉じる（保存済みなので確認なしで閉じる）
    fireEvent.click(screen.getByTestId('tab-close-A文書.md'));
    await waitFor(() => {
      expect(screen.queryByTestId('tab-A文書.md')).toBeNull();
    });

    // 再度 A文書を開く
    useTabsStore.getState().openDoc('A文書.md', { pinned: true });
    const newContainerA = await screen.findByTestId(/doctab-A文書\.md/);

    // 初期状態は折りたたみ
    const toggle = await within(newContainerA).findByRole('button', { name: /プロパティ/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    // 展開すると保存された新しい値が見える
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(within(newContainerA).getByText('保存された新タイトル')).toBeTruthy();
    });
  });

  it('IE7: rename の往復: キー price を cost に変えて保存 → PUT は rename 1 件、応答の frontmatter で cost 行になる', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });
    const tabContainerA = await screen.findByTestId(/doctab-A文書\.md/);
    await within(tabContainerA).findByRole('button', { name: '保存' });

    // プロパティフォームを開く
    fireEvent.click(within(tabContainerA).getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(within(tabContainerA).getByTestId('properties-edit'));

    // price のキー名を cost に変更
    const keyInput = within(tabContainerA).getByDisplayValue('price');
    fireEvent.change(keyInput, { target: { value: 'cost' } });

    // 保存
    fireEvent.click(within(tabContainerA).getByRole('button', { name: '保存' }));

    // PUT の内容を検証
    await waitFor(() => expect(recordedPuts).toHaveLength(1));
    expect(recordedPuts[0].frontmatterOps).toEqual([{ op: 'rename', from: 'price', to: 'cost' }]);

    // 保存後、cost のキー名として表示されること
    await waitFor(() => {
      expect(within(tabContainerA).getByDisplayValue('cost')).toBeTruthy();
    });
  });

  it('IE8: タグ編集との非干渉: タグチップ追加 + プロパティ変更 → PUT に tags と frontmatterOps の両方。パネルに tags 行は出ない', async () => {
    renderApp(['/doc/A文書.md']);
    await screen.findByRole('heading', { name: 'A文書' });
    const tabContainerA = await screen.findByTestId(/doctab-A文書\.md/);
    await within(tabContainerA).findByRole('button', { name: '保存' });

    // プロパティで title を変更
    fireEvent.click(within(tabContainerA).getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(within(tabContainerA).getByTestId('properties-edit'));
    fireEvent.change(within(tabContainerA).getByLabelText('title の値'), { target: { value: 'タグ併用タイトル' } });

    // タグチップ「+ タグを追加」から「追加タグ」を追加
    const addTagBtn = within(tabContainerA).getByRole('button', { name: '+ タグを追加' });
    fireEvent.click(addTagBtn);
    const tagInput = within(tabContainerA).getByPlaceholderText('タグ名');
    fireEvent.change(tagInput, { target: { value: '追加タグ' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });

    // 保存
    fireEvent.click(within(tabContainerA).getByRole('button', { name: '保存' }));

    // PUT の内容を検証: tags と frontmatterOps が両方載っていること
    await waitFor(() => expect(recordedPuts).toHaveLength(1));
    expect(recordedPuts[0].tags).toEqual(['重要', '追加タグ']);
    expect(recordedPuts[0].frontmatterOps).toEqual([{ op: 'set', key: 'title', value: 'タグ併用タイトル' }]);

    // プロパティパネル内に tags のキー入力欄は存在しないこと
    expect(within(tabContainerA).queryByDisplayValue('tags')).toBeNull();
  });
});
