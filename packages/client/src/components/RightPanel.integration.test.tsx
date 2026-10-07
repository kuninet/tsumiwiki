import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BacklinksResponse, DocResponse, User } from '@tsumiwiki/shared';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
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

const DOC_A: DocResponse = {
  path: 'A文書.md',
  body: 'A文書の本文',
  tags: [],
  frontmatter: {},
  updatedAt: '2026-07-01T00:00:00Z',
  lock: null,
};

const DOC_B: DocResponse = {
  path: 'B文書.md',
  body: 'B文書の本文 [[A文書.md]]',
  tags: [],
  frontmatter: {},
  updatedAt: '2026-07-02T00:00:00Z',
  lock: null,
};

const DOC_C: DocResponse = {
  path: 'C文書.md',
  body: 'C文書の本文 [[B文書.md]]',
  tags: [],
  frontmatter: {},
  updatedAt: '2026-07-03T00:00:00Z',
  lock: null,
};

const DOCS_DB: Record<string, DocResponse> = {
  'A文書.md': DOC_A,
  'B文書.md': DOC_B,
  'C文書.md': DOC_C,
};

function LocationProbe({ onLocationChange }: { onLocationChange?: (path: string) => void }) {
  const location = useLocation();
  onLocationChange?.(location.pathname);
  return <div data-testid="current-pathname">{location.pathname}</div>;
}

function stubMatchMedia(matches = false) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe('RightPanel Integration (C-6, C-7)', () => {
  let backlinksCalls: string[] = [];
  let historyRestoreCalls: { path: string; rev: string }[] = [];
  let apiCalls: { method: string; path: string; search?: string }[] = [];

  function setupFetchMock() {
    backlinksCalls = [];
    historyRestoreCalls = [];
    apiCalls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const urlObj = new URL(url, 'http://localhost');
        const pathname = urlObj.pathname;
        const queryPath = urlObj.searchParams.get('path');
        const method = (init?.method ?? 'GET').toUpperCase();
        apiCalls.push({ method, path: pathname, search: urlObj.search });

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
                docs: [
                  { path: 'A文書.md', title: 'A文書', folder: '', updatedAt: '2026-07-01T00:00:00Z' },
                  { path: 'B文書.md', title: 'B文書', folder: '', updatedAt: '2026-07-02T00:00:00Z' },
                  { path: 'C文書.md', title: 'C文書', folder: '', updatedAt: '2026-07-03T00:00:00Z' },
                ],
              }),
          });
        }
        if (pathname === '/api/docs') {
          const doc = queryPath && DOCS_DB[queryPath];
          if (doc) {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(doc) });
          }
          return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'Not found' }) });
        }
        if (pathname === '/api/docs/backlinks') {
          if (queryPath) {
            backlinksCalls.push(queryPath);
          }
          let backlinks: BacklinksResponse['backlinks'] = [];
          if (queryPath === 'A文書.md') {
            backlinks = [
              {
                sourcePath: 'B文書.md',
                sourceTitle: 'B文書',
                sourceFolder: '',
                sourceUpdatedAt: '2026-07-02T00:00:00Z',
                links: [{ line: 1, context: 'B文書の本文 [[A文書.md]]', anchor: null, alias: null }],
              },
            ];
          } else if (queryPath === 'B文書.md') {
            backlinks = [
              {
                sourcePath: 'C文書.md',
                sourceTitle: 'C文書',
                sourceFolder: '',
                sourceUpdatedAt: '2026-07-03T00:00:00Z',
                links: [{ line: 1, context: 'C文書の本文 [[B文書.md]]', anchor: null, alias: null }],
              },
            ];
          }
          const response: BacklinksResponse = {
            backlinks,
            truncated: false,
          };
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(response) });
        }
        if (pathname === '/api/history') {
          const docPath = queryPath ?? 'A文書.md';
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                history: [
                  {
                    rev: docPath === 'B文書.md' ? 'rev-b-1' : 'abc1234',
                    authorName: '太郎',
                    date: '2026-07-01T00:00:00Z',
                    message: docPath === 'B文書.md' ? 'B文書の作成' : '初回作成',
                  },
                ],
              }),
          });
        }
        if (pathname === '/api/history/all') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                history: [
                  {
                    rev: 'rev-all-1',
                    authorName: '次郎',
                    date: '2026-07-03T00:00:00Z',
                    message: '全体コミット',
                    paths: ['A文書.md', 'B文書.md'],
                  },
                ],
              }),
          });
        }
        if (pathname === '/api/history/content') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ content: '過去の本文プレビュー' }),
          });
        }
        if (pathname === '/api/history/diff' || pathname === '/api/history/all/diff') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ diff: '@@ -1 +1 @@\n-旧\n+新' }),
          });
        }
        if (pathname === '/api/history/restore' && method === 'POST') {
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
          historyRestoreCalls.push(body);
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ updatedAt: '2026-07-04T00:00:00Z' }),
          });
        }
        if (pathname === '/api/docs/recent') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ docs: [] }) });
        }
        if (pathname === '/api/locks') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ tags: [] }) });
      }),
    );
  }

  beforeEach(() => {
    stubMatchMedia(false);
    localStorage.clear();
    useTabsStore.getState().reset();
    useEditStore.setState({ mode: 'view' });
    useUserSettingsStore.setState({
      rightPanelOpen: false,
      rightPanelWidth: 320,
      rightPanelTab: 'backlinks',
      backlinksSort: 'updated-desc',
    });
    useUIStore.setState({
      sidebarCollapsed: false,
      sidebarWidth: 260,
      rightDrawerOpen: false,
      rightPanelSlot: null,
    });
    DOCS_DB['A文書.md'] = DOC_A;
    setupFetchMock();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderIntegration(initialEntries = ['/doc/A文書.md'], onLoc?: (path: string) => void) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>
          <LocationProbe onLocationChange={onLoc} />
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<MainPage />} />
              <Route path="doc/*" element={<MainPage />} />
              <Route path="trash" element={<div>ゴミ箱</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  describe('C-6: 活性ペイン追従とポータル描画', () => {
    it('C-6-1: 単一ペインで A文書.md 表示、パネル閉時は backlinks fetch が 0 回', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });
      expect(backlinksCalls.filter((p) => p === 'A文書.md')).toHaveLength(0);
    });

    it('C-6-2: ヘッダーの右ボタンで開くと backlinks(A文書.md) 1回、スロット直下の子が1つで本文スクロール内に backlinks-panel が無い', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });

      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));

      await waitFor(() => {
        expect(backlinksCalls.filter((p) => p === 'A文書.md')).toHaveLength(1);
      });

      const slot = screen.getByTestId('right-panel-slot');
      expect(slot.children.length).toBe(1);
      expect(slot.firstElementChild?.getAttribute('data-testid')).toBe('right-panel-content-backlinks');

      const contentWrap = screen.getByTestId('doc-content-wrap');
      expect(contentWrap.querySelector('[data-testid="backlinks-panel"]')).toBeNull();
    });

    it('C-6-3: A文書.md 表示・パネル開でタブUIクリックにより B文書.md を開くと backlinks(B文書.md) が呼ばれスロットの子はちょうど1つかつ C文書.md を表示', async () => {
      // 事前に B文書.md をタブとして開き、A文書.md をアクティブにしておく
      useTabsStore.getState().openDoc('B文書.md', { pinned: true });
      useTabsStore.getState().openDoc('A文書.md', { pinned: true });

      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });
      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));

      await waitFor(() => {
        expect(backlinksCalls.filter((p) => p === 'A文書.md').length).toBeGreaterThanOrEqual(1);
      });
      const aCallsBefore = backlinksCalls.filter((p) => p === 'A文書.md').length;

      // タブUIのクリックで B文書.md に切り替え
      const bTab = screen.getByTestId('tab-B文書.md');
      fireEvent.click(bTab);
      await screen.findByRole('heading', { name: 'B文書' });

      await waitFor(() => {
        expect(backlinksCalls.filter((p) => p === 'B文書.md').length).toBeGreaterThanOrEqual(1);
      });
      // A文書.md の呼び出しは増えない
      expect(backlinksCalls.filter((p) => p === 'A文書.md')).toHaveLength(aCallsBefore);

      const slot = screen.getByTestId('right-panel-slot');
      expect(slot.children.length).toBe(1);
      expect(await screen.findByTestId('backlink-item-C文書.md')).toBeTruthy();
      expect(screen.queryByTestId('backlink-item-B文書.md')).toBeNull();
    });

    it('C-6-4〜C-6-6: 分割ペインで左右切替時にスロットの内容が追従し、スロット内クリックでは活性ペインが変わらない', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });
      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));

      // A文書が活性なので B文書.md へのバックリンクが存在するまで待つ
      expect(await screen.findByTestId('backlink-item-B文書.md')).toBeTruthy();
      expect(screen.queryByTestId('backlink-item-C文書.md')).toBeNull();

      const aCallsBefore = backlinksCalls.filter((p) => p === 'A文書.md').length;

      // 右に B文書.md を分割配置
      const leftPaneId = useTabsStore.getState().activePaneId;
      useTabsStore.getState().openDoc('B文書.md', { pinned: true });
      useTabsStore.getState().splitOrMove('B文書.md', leftPaneId, 'right');

      // split 後の root から右ペインの ID を取得し活性化
      const root = useTabsStore.getState().root;
      expect(root.kind).toBe('split');
      const rightPaneId = (root as { a: { id: string }; b: { id: string } }).b.id;
      const rightPaneEl = await screen.findByTestId(`pane-${rightPaneId}`);
      fireEvent.mouseDown(rightPaneEl);

      await waitFor(() => {
        expect(backlinksCalls.filter((p) => p === 'B文書.md').length).toBeGreaterThanOrEqual(1);
      });
      expect(backlinksCalls.filter((p) => p === 'A文書.md')).toHaveLength(aCallsBefore);

      // C-6-4: B文書が活性なのでスロット内は C文書.md のバックリンクになり、B文書.md は存在しない
      expect(await screen.findByTestId('backlink-item-C文書.md')).toBeTruthy();
      expect(screen.queryByTestId('backlink-item-B文書.md')).toBeNull();

      // C-6-5: スロット内のコンテンツでの mousedown は activePaneId を変えない
      const currentActivePaneId = useTabsStore.getState().activePaneId;
      const contentEl = screen.getByTestId('right-panel-content-backlinks');
      fireEvent.mouseDown(contentEl);
      expect(useTabsStore.getState().activePaneId).toBe(currentActivePaneId);

      // C-6-6: 左ペイン(A文書.md)を mousedown → A文書.md に戻り、スロットも追従
      const leftPaneEl = await screen.findByTestId(`pane-${leftPaneId}`);
      fireEvent.mouseDown(leftPaneEl);

      await waitFor(() => {
        const slotEl = screen.getByTestId('right-panel-slot');
        expect(slotEl.children.length).toBe(1);
      });
      expect(await screen.findByTestId('backlink-item-B文書.md')).toBeTruthy();
      expect(screen.queryByTestId('backlink-item-C文書.md')).toBeNull();
    });

    it('C-6-7: 分割ペインでパネル閉時はペインを切り替えても backlinks fetch は 0 回', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });

      const leftPaneId = useTabsStore.getState().activePaneId;
      useTabsStore.getState().openDoc('B文書.md', { pinned: true });
      useTabsStore.getState().splitOrMove('B文書.md', leftPaneId, 'right');

      const root = useTabsStore.getState().root;
      expect(root.kind).toBe('split');
      const rightPaneId = (root as { a: { id: string }; b: { id: string } }).b.id;
      const leftPaneEl = await screen.findByTestId(`pane-${leftPaneId}`);
      const rightPaneEl = await screen.findByTestId(`pane-${rightPaneId}`);

      fireEvent.mouseDown(rightPaneEl);
      fireEvent.mouseDown(leftPaneEl);

      expect(backlinksCalls).toHaveLength(0);
    });

    it('C-6-8: 履歴タブ選択中は backlinks fetch は 0 回', async () => {
      useUserSettingsStore.setState({ rightPanelTab: 'history' });

      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });
      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));

      expect(await screen.findByTestId('history-panel')).toBeTruthy();
      expect(backlinksCalls).toHaveLength(0);
    });

    it('C-6-9: A文書.md 表示・パネル開から / (URL空) へ移動するとスロットは空で right-panel-empty が表示される', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });
      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));

      await waitFor(() => {
        expect(backlinksCalls.filter((p) => p === 'A文書.md').length).toBeGreaterThanOrEqual(1);
      });
      const aCallsBefore = backlinksCalls.filter((p) => p === 'A文書.md').length;

      // ホームアイコン（/）をクリックしてルートへ移動
      fireEvent.click(screen.getByRole('link', { name: /TsumiWiki/ }));

      await waitFor(() => {
        expect(screen.getByTestId('right-panel-empty')).toBeTruthy();
      });
      const slot = screen.getByTestId('right-panel-slot');
      expect(slot.children.length).toBe(0);
      expect(backlinksCalls.filter((p) => p === 'A文書.md')).toHaveLength(aCallsBefore);
    });

    it('C-6-10: mobile で右ドロワー閉時は backlinks fetch 0回、スロットの子 0', async () => {
      stubMatchMedia(true);
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });

      expect(backlinksCalls).toHaveLength(0);
      const slot = screen.getByTestId('right-panel-slot');
      expect(slot.children.length).toBe(0);
    });

    it('C-6-11: 単一ペインでタブ A文書.md(活性)と B文書.md(非表示)が開いている場合、スロットの子は1つで B文書.md の fetch は 0 回', async () => {
      // 事前に B文書.md を非表示タブとして追加
      useTabsStore.getState().openDoc('B文書.md');
      useTabsStore.getState().openDoc('A文書.md');
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });
      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));

      await waitFor(() => {
        expect(backlinksCalls.filter((p) => p === 'A文書.md')).toHaveLength(1);
      });
      expect(backlinksCalls.filter((p) => p === 'B文書.md')).toHaveLength(0);

      const slot = screen.getByTestId('right-panel-slot');
      expect(slot.children.length).toBe(1);
    });
  });

  describe('C-7: 組み込み状態の実クリック到達', () => {
    it('C-7-1: A文書.md 表示中、右パネルを開いて backlink-item-B文書.md をクリックすると B文書.md へ遷移', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });

      // 右パネルを開くボタンで右パネルを開く
      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));

      expect(useUserSettingsStore.getState().rightPanelOpen).toBe(true);

      const backlinkItem = await screen.findByTestId('backlink-item-B文書.md');
      fireEvent.click(backlinkItem);

      await waitFor(() => {
        expect(screen.getByTestId('current-pathname').textContent).toBe(encodeURI('/doc/B文書.md'));
      });
    });

    it('C-7-2: 並び順 select で name-desc を選ぶと localStorage backlinksSort が更新される', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });

      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
      const select = await screen.findByTestId('backlinks-sort-select');

      fireEvent.change(select, { target: { value: 'name-desc' } });
      expect(useUserSettingsStore.getState().backlinksSort).toBe('name-desc');
    });

    it('C-7-3: 編集モード中に右パネルを開いても編集モードが維持される', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });

      // 編集モードに入る
      await screen.findByRole('button', { name: /保存/ });
      expect(useEditStore.getState().mode).toBe('edit');

      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
      expect(useUserSettingsStore.getState().rightPanelOpen).toBe(true);
      expect(useEditStore.getState().mode).toBe('edit');
    });

    it('C-7-4: エディタ DOM にフォーカスがあるとき Escape ではパネルは閉じない', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });
      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
      expect(useUserSettingsStore.getState().rightPanelOpen).toBe(true);

      const editorEl = document.querySelector('.ProseMirror') as HTMLElement;
      expect(editorEl).toBeTruthy();
      editorEl.focus();

      fireEvent.keyDown(editorEl, { key: 'Escape' });
      expect(useUserSettingsStore.getState().rightPanelOpen).toBe(true);
    });

    it('C-7-5: エディタ DOM にフォーカス時 Ctrl+Shift+U で右パネルが開きフォーカスはエディタに残る', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });

      const editorEl = document.querySelector('.ProseMirror') as HTMLElement;
      expect(editorEl).toBeTruthy();
      editorEl.focus();

      fireEvent.keyDown(editorEl, { key: 'U', ctrlKey: true, shiftKey: true });
      expect(useUserSettingsStore.getState().rightPanelOpen).toBe(true);
      expect(document.activeElement).toBe(editorEl);
    });

    it('C-7-6: mobile でエディタフォーカス中に右ドロワーを開くと blur される(D13)', async () => {
      stubMatchMedia(true);
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });

      // 編集モードに入る
      await screen.findByRole('button', { name: /保存/ });
      expect(useEditStore.getState().mode).toBe('edit');

      const editorEl = document.querySelector('.ProseMirror') as HTMLElement;
      expect(editorEl).toBeTruthy();
      editorEl.focus();
      expect(document.activeElement).toBe(editorEl);

      // 右パネルを開くボタンをタップ
      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));

      expect(useUIStore.getState().rightDrawerOpen).toBe(true);
      // D13: blur されてアクティブ要素でなくなる
      expect(document.activeElement).not.toBe(editorEl);
    });

    it('C-7-15: パネル内のクリックイベントは DocView 本文コンテナに到達しない', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });
      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));

      const backlinkItem = await screen.findByTestId('backlink-item-B文書.md');
      // パネル内のクリック
      fireEvent.click(backlinkItem);
      // ドキュメント遷移が正常に行われ、余計なエラー等が生じないこと
      await waitFor(() => {
        expect(screen.getByTestId('current-pathname').textContent).toBe(encodeURI('/doc/B文書.md'));
      });
    });

    it('C-7-16: パネル内のバックリンク項目にフォーカスがあるとき Escape でパネルが閉じる', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });
      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));

      const backlinkItem = await screen.findByTestId('backlink-item-B文書.md');
      backlinkItem.focus();

      fireEvent.keyDown(backlinkItem, { key: 'Escape' });
      expect(useUserSettingsStore.getState().rightPanelOpen).toBe(false);
    });

    it('C-7-7: 履歴タブ切替時に /api/history?path=A文書.md が呼ばれ一覧が表示される', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });
      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));

      // 初期は backlinks
      expect(useUserSettingsStore.getState().rightPanelTab).toBe('backlinks');
      expect(apiCalls.some((c) => c.path === '/api/history')).toBe(false);

      // 履歴タブをクリック
      fireEvent.click(screen.getByRole('tab', { name: '履歴' }));
      expect(useUserSettingsStore.getState().rightPanelTab).toBe('history');

      // HistoryPanel の描画と一覧表示
      expect(await screen.findByTestId('history-panel')).toBeTruthy();
      expect(await screen.findByText(/初回作成/)).toBeTruthy();

      // /api/history?path=A文書.md の呼び出しを検証
      const historyCall = apiCalls.find((c) => c.path === '/api/history');
      expect(historyCall).toBeTruthy();
      expect(decodeURIComponent(historyCall!.search ?? '')).toContain('path=A文書.md');
    });

    it('C-7-8: 内容タブ切替で /api/history/content が呼ばれ本文プレビューが表示される', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });
      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
      fireEvent.click(screen.getByRole('tab', { name: '履歴' }));

      expect(await screen.findByTestId('history-panel')).toBeTruthy();
      expect(await screen.findByText(/初回作成/)).toBeTruthy();

      // 自動選択された後、「内容」タブをクリック
      await waitFor(() => {
        const btn = screen.getByRole('button', { name: 'この版に戻す' }) as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
      });

      fireEvent.click(screen.getByRole('button', { name: '内容' }));

      // 本文プレビューが表示される
      expect(await screen.findByText('過去の本文プレビュー')).toBeTruthy();
      const contentCall = apiCalls.find((c) => c.path === '/api/history/content');
      expect(contentCall).toBeTruthy();
      expect(decodeURIComponent(contentCall!.search ?? '')).toContain('path=A文書.md');
      expect(decodeURIComponent(contentCall!.search ?? '')).toContain('rev=abc1234');
    });

    it('C-7-9: スコープを「全体」に切り替えると /api/history/all が取得され、「この文書」で再取得される', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });
      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
      fireEvent.click(screen.getByRole('tab', { name: '履歴' }));

      expect(await screen.findByTestId('history-panel')).toBeTruthy();
      expect(await screen.findByText(/初回作成/)).toBeTruthy();

      // 「全体」スコープをクリック
      fireEvent.click(screen.getByRole('tab', { name: '全体' }));
      expect(await screen.findByText(/全体コミット/)).toBeTruthy();
      expect(apiCalls.some((c) => c.path === '/api/history/all')).toBe(true);

      // 「この文書」スコープをクリック
      fireEvent.click(screen.getByRole('tab', { name: 'この文書' }));
      expect(await screen.findByText(/初回作成/)).toBeTruthy();
    });

    it('C-7-10: 復元確認ダイアログの表示と文言(未保存変更あり時は警告が含まれる)', async () => {
      DOCS_DB['A文書.md'] = { ...DOC_A, tags: ['テスト'] };
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });

      // 自動で編集モードに入るのを待つ
      await screen.findByRole('button', { name: /保存/ });

      // タグを削除して dirty=true にする
      fireEvent.click(screen.getByRole('button', { name: 'タグ #テスト を削除' }));

      // 保存ボタンが活性化して dirty=true になったことを確認
      await waitFor(() => {
        const saveBtn = screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement;
        expect(saveBtn.disabled).toBe(false);
      });

      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
      fireEvent.click(screen.getByRole('tab', { name: '履歴' }));

      expect(await screen.findByTestId('history-panel')).toBeTruthy();
      await waitFor(() => {
        const btn = screen.getByRole('button', { name: 'この版に戻す' }) as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
      });

      // 「この版に戻す」をクリック
      fireEvent.click(screen.getByRole('button', { name: 'この版に戻す' }));

      // ダイアログが表示され、isDirty の警告文言が含まれる
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toBeTruthy();
      expect(within(dialog).getByText(/未保存の変更が失われます/)).toBeTruthy();

      // キャンセル
      fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
      expect(screen.queryByRole('dialog')).toBeNull();

      DOCS_DB['A文書.md'] = DOC_A;
    });

    it('C-7-11: 復元確認ダイアログは document.body 直下にポータル描画される(D9)', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });
      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
      fireEvent.click(screen.getByRole('tab', { name: '履歴' }));

      expect(await screen.findByTestId('history-panel')).toBeTruthy();
      await waitFor(() => {
        const btn = screen.getByRole('button', { name: 'この版に戻す' }) as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
      });

      fireEvent.click(screen.getByRole('button', { name: 'この版に戻す' }));

      const dialog = document.body.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
      const panel = screen.getByTestId('history-panel');
      expect(panel.contains(dialog)).toBe(false);
    });

    it('C-7-12: 復元実行時の順序保証(DELETE /api/locks → POST /api/history/restore)と復元後の選択解除', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });

      // 編集モードに入った状態で復元
      await screen.findByRole('button', { name: /保存/ });
      expect(useEditStore.getState().mode).toBe('edit');

      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
      fireEvent.click(screen.getByRole('tab', { name: '履歴' }));

      expect(await screen.findByTestId('history-panel')).toBeTruthy();
      await waitFor(() => {
        const btn = screen.getByRole('button', { name: 'この版に戻す' }) as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
      });

      // 復元実行
      fireEvent.click(screen.getByRole('button', { name: 'この版に戻す' }));
      fireEvent.click(await screen.findByRole('button', { name: '戻す' }));

      await waitFor(() => {
        expect(historyRestoreCalls.length).toBe(1);
      });
      expect(historyRestoreCalls[0]).toEqual({ path: 'A文書.md', rev: 'abc1234' });

      // 順序保証: beforeRestore による DELETE /api/locks が POST /api/history/restore より前に実行されていること
      const deleteLockIdx = apiCalls.findIndex((c) => c.method === 'DELETE' && c.path === '/api/locks');
      const restoreIdx = apiCalls.findIndex((c) => c.method === 'POST' && c.path === '/api/history/restore');
      expect(deleteLockIdx).toBeGreaterThanOrEqual(0);
      expect(restoreIdx).toBeGreaterThanOrEqual(0);
      expect(deleteLockIdx).toBeLessThan(restoreIdx);

      // 復元完了後、選択解除され「この版に戻す」が disabled になること
      await waitFor(() => {
        const btn = screen.getByRole('button', { name: 'この版に戻す' }) as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
      });
    });

    it('C-7-13: 分割ペイン切替時に右パネルの履歴内容がアクティブペインに追従する', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });

      // 左右ペイン分割のセットアップ
      const leftPaneId = useTabsStore.getState().activePaneId;
      useTabsStore.getState().openDoc('B文書.md', { pinned: true });
      useTabsStore.getState().splitOrMove('B文書.md', leftPaneId, 'right');

      await screen.findByRole('heading', { name: 'B文書' });

      const root = useTabsStore.getState().root;
      const rightPaneId = (root as { a: { id: string }; b: { id: string } }).b.id;
      const leftPaneEl = await screen.findByTestId(`pane-${leftPaneId}`);
      const rightPaneEl = await screen.findByTestId(`pane-${rightPaneId}`);

      // splitOrMove 直後は新ペイン(右)がアクティブになるため、左ペイン(A文書)をクリックして初期化
      fireEvent.mouseDown(leftPaneEl);

      // 右パネルを開いて「履歴」タブを選択
      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
      fireEvent.click(screen.getByRole('tab', { name: '履歴' }));

      // 初期状態: 左ペイン(A文書)がアクティブ → A文書の履歴(初回作成)が表示
      expect(await screen.findByText(/初回作成/)).toBeTruthy();

      // 右ペイン(B文書)をクリック → B文書の履歴(B文書の作成)が表示
      fireEvent.mouseDown(rightPaneEl);
      expect(await screen.findByText(/B文書の作成/)).toBeTruthy();

      // 再度左ペイン(A文書)をクリック → A文書の履歴(初回作成)に切り替わる
      fireEvent.mouseDown(leftPaneEl);
      expect(await screen.findByText(/初回作成/)).toBeTruthy();
    });

    it('C-7-14: 全画面リンクが対象文書の /history ページを指している', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });
      fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
      fireEvent.click(screen.getByRole('tab', { name: '履歴' }));

      expect(await screen.findByTestId('history-panel')).toBeTruthy();

      const fullscreenLink = screen.getByRole('link', { name: '履歴を全画面で開く' });
      expect(fullscreenLink).toBeTruthy();
      expect(fullscreenLink.getAttribute('href')).toBe('/history/A%E6%96%87%E6%9B%B8.md');
    });
  });
});
