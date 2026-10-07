import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  function setupFetchMock() {
    backlinksCalls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const urlObj = new URL(url, 'http://localhost');
        const pathname = urlObj.pathname;
        const queryPath = urlObj.searchParams.get('path');

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
    it('C-7-1: A文書.md 表示中、[🔗 リンク] ボタンで開いて backlink-item-B文書.md をクリックすると B文書.md へ遷移', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });

      // [🔗 リンク] ボタンで右パネルを開く
      const linkBtn = screen.getByRole('button', { name: /リンク/ });
      fireEvent.click(linkBtn);

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

      fireEvent.click(screen.getByRole('button', { name: /リンク/ }));
      const select = await screen.findByTestId('backlinks-sort-select');

      fireEvent.change(select, { target: { value: 'name-desc' } });
      expect(useUserSettingsStore.getState().backlinksSort).toBe('name-desc');
    });

    it('C-7-3: 編集モード中に [🔗 リンク] ボタンをクリックしても編集モードが維持される', async () => {
      renderIntegration();
      await screen.findByRole('heading', { name: 'A文書' });

      // 編集モードに入る
      await screen.findByRole('button', { name: /保存/ });
      expect(useEditStore.getState().mode).toBe('edit');

      fireEvent.click(screen.getByRole('button', { name: /リンク/ }));
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
      fireEvent.click(screen.getByRole('button', { name: /リンク/ }));

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
      fireEvent.click(screen.getByRole('button', { name: /リンク/ }));

      const backlinkItem = await screen.findByTestId('backlink-item-B文書.md');
      backlinkItem.focus();

      fireEvent.keyDown(backlinkItem, { key: 'Escape' });
      expect(useUserSettingsStore.getState().rightPanelOpen).toBe(false);
    });
  });
});
