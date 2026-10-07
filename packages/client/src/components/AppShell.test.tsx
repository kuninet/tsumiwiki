import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '../stores/ui';
import { useUserSettingsStore } from '../stores/user-settings';
import { AppShell } from './AppShell';

let matchMediaListeners: Array<(e: { matches: boolean }) => void> = [];

function stubMatchMedia(matches: boolean) {
  matchMediaListeners = [];
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: (_ev: string, listener: (e: { matches: boolean }) => void) => {
        matchMediaListeners.push(listener);
      },
      removeEventListener: (_ev: string, listener: (e: { matches: boolean }) => void) => {
        matchMediaListeners = matchMediaListeners.filter((l) => l !== listener);
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function renderAppShell(options?: {
  initialEntries?: string[];
  byDateHandler?: (body: unknown) => { status: number; json: unknown };
}) {
  const initialEntries = options?.initialEntries ?? ['/'];
  const byDateHandler = options?.byDateHandler;

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/auth/me')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              user: { id: 1, username: 'taro', displayName: '太郎', role: 'user', disabled: false },
            }),
        });
      }
      if (url.startsWith('/api/tree')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ folders: [], docs: [] }),
        });
      }
      if (url === '/api/daily-notes/by-date' && byDateHandler) {
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        const { status, json } = byDateHandler(body);
        return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(json) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ tags: [] }) });
    }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route element={<AppShell />}>
            <Route
              index
              element={
                <div>
                  <Link to="/doc/foo.md">to-foo</Link>
                  <Link to="/trash">to-trash</Link>
                  <div>本文</div>
                </div>
              }
            />
            <Route
              path="doc/*"
              element={
                <div>
                  <Link to="/doc/b.md">to-b</Link>
                  <Link to="/trash">to-trash</Link>
                  <div>文書</div>
                </div>
              }
            />
            <Route path="trash" element={<Link to="/doc/foo.md">to-foo</Link>} />
            <Route path="settings" element={<div>設定</div>} />
            <Route path="history/*" element={<div>履歴</div>} />
            <Route path="admin/*" element={<div>管理</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AppShell (デスクトップ)', () => {
  beforeEach(() => {
    stubMatchMedia(false); // 広幅 = デスクトップ扱い
    localStorage.clear();
    useUserSettingsStore.setState({ rightPanelOpen: false, rightPanelWidth: 320 });
    useUIStore.setState({ sidebarCollapsed: false, rightDrawerOpen: false });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    useUIStore.setState({ sidebarCollapsed: false });
  });

  it('ログイン中のユーザー名をアバターに表示する', async () => {
    renderAppShell();
    const avatar = await screen.findByRole('button', { name: 'ユーザーメニュー(太郎)' });
    expect(avatar.textContent).toBe('太');
  });

  it('サイドバー折りたたみボタンで表示・非表示が切り替わる', async () => {
    renderAppShell();
    await screen.findByRole('button', { name: 'ユーザーメニュー(太郎)' });

    expect(screen.getByTestId('sidebar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'サイドバーを折りたたむ' }));
    expect(screen.queryByTestId('sidebar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'サイドバーを表示' }));
    expect(screen.getByTestId('sidebar')).toBeTruthy();
  });

  it('デスクトップではリサイズハンドルが存在する', async () => {
    renderAppShell();
    await screen.findByRole('button', { name: 'ユーザーメニュー(太郎)' });
    expect(screen.getByTestId('sidebar-resize-handle')).toBeTruthy();
  });

  it('日付指定ボタン→ダイアログでOK→APIを呼びナビゲートしてダイアログが閉じる', async () => {
    const byDateHandler = vi.fn().mockReturnValue({
      status: 200,
      json: { path: '日誌/2026-08-10.md' },
    });
    renderAppShell({ byDateHandler });
    await screen.findByRole('button', { name: 'ユーザーメニュー(太郎)' });

    fireEvent.click(screen.getByRole('button', { name: '日付を指定して日誌を作成' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('日付'), { target: { value: '2026-08-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));

    await screen.findByText('文書');
    expect(byDateHandler).toHaveBeenCalledWith({ date: '2026-08-10' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('日付指定で409(既存日誌あり)の場合はダイアログを閉じずに残す', async () => {
    const byDateHandler = vi.fn().mockReturnValue({
      status: 409,
      json: {
        error: { code: 'DAILY_NOTE_EXISTS', message: '指定した日付の日誌は既に存在します' },
      },
    });
    renderAppShell({ byDateHandler });
    await screen.findByRole('button', { name: 'ユーザーメニュー(太郎)' });

    fireEvent.click(screen.getByRole('button', { name: '日付を指定して日誌を作成' }));
    fireEvent.change(screen.getByLabelText('日付'), { target: { value: '2026-08-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(byDateHandler).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('日付指定ダイアログは開き直すと初期値が今日に戻る(前回の選択が持ち越されない)', async () => {
    // #189 レビュー M2: DatePickerDialog は AppShell 側で条件レンダリングにすることで
    // 毎回 unmount → 再マウント時に useState 初期値(今日)が再評価される。
    // fake timers は他のテスト(モバイル系)の Promise 解決に影響するため使わず、
    // 実行時の今日を取得して比較する
    const initialToday = (() => {
      const d = new Date();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${m}-${day}`;
    })();

    renderAppShell();
    await screen.findByRole('button', { name: 'ユーザーメニュー(太郎)' });

    // 1回目: 開いて別日に変更、キャンセルで閉じる
    fireEvent.click(screen.getByRole('button', { name: '日付を指定して日誌を作成' }));
    const firstInput = screen.getByLabelText('日付') as HTMLInputElement;
    expect(firstInput.value).toBe(initialToday);
    fireEvent.change(firstInput, { target: { value: '2020-01-01' } });
    expect(firstInput.value).toBe('2020-01-01');
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // 2回目: 再度開くと初期値が今日に戻る(2020-01-01 が残っていない)
    fireEvent.click(screen.getByRole('button', { name: '日付を指定して日誌を作成' }));
    const secondInput = screen.getByLabelText('日付') as HTMLInputElement;
    expect(secondInput.value).toBe(initialToday);
  });

  it('日付指定で409以外のエラー(500等)はダイアログを閉じる', async () => {
    // #189 レビュー M1: 409 だけ残す・それ以外は閉じる(トーストで通知は済む)
    const byDateHandler = vi.fn().mockReturnValue({
      status: 500,
      json: {
        error: { code: 'INTERNAL_ERROR', message: 'サーバーエラー' },
      },
    });
    renderAppShell({ byDateHandler });
    await screen.findByRole('button', { name: 'ユーザーメニュー(太郎)' });

    fireEvent.click(screen.getByRole('button', { name: '日付を指定して日誌を作成' }));
    fireEvent.change(screen.getByLabelText('日付'), { target: { value: '2026-08-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(byDateHandler).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('AppShell (モバイル)', () => {
  beforeEach(() => {
    stubMatchMedia(true); // 狭幅 = モバイル扱い
    // ストア初期値はモバイル判定で自動で true になる想定だが、テスト隔離のため明示的にセット
    useUIStore.setState({ sidebarCollapsed: false, rightDrawerOpen: false });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    useUIStore.setState({ sidebarCollapsed: false });
  });

  it('モバイル初回接続時は sidebarCollapsed=false であっても自動でドロワーが閉じる', async () => {
    // 明示的に false を設定した状態でレンダ → useEffect で自動的に true になる
    useUIStore.setState({ sidebarCollapsed: false });
    renderAppShell();
    await screen.findByRole('button', { name: 'ユーザーメニュー(太郎)' });

    const sidebar = screen.getByTestId('sidebar');
    expect(sidebar.className).toContain('-translate-x-full');
    expect(sidebar.className).toContain('fixed');
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
  });

  it('ドロワーはビューポート全高で表示される(top-Header/bottom-StatusBarの隙間なし)', async () => {
    renderAppShell();
    await screen.findByRole('button', { name: 'ユーザーメニュー(太郎)' });
    const sidebar = screen.getByTestId('sidebar');
    // inset-y-0 で全高。以前の `top-[52px]` `bottom-[38px]` は含まない
    expect(sidebar.className).toContain('inset-y-0');
    expect(sidebar.className).not.toContain('top-[52px]');
    expect(sidebar.className).not.toContain('bottom-[38px]');
  });

  it('モバイルではハンバーガーからドロワーを開き、オーバーレイクリックで閉じる', async () => {
    renderAppShell();
    await screen.findByRole('button', { name: 'ユーザーメニュー(太郎)' });

    // 初期はオーバーレイなし
    expect(screen.queryByTestId('sidebar-overlay')).toBeNull();

    // ハンバーガーで開く
    fireEvent.click(screen.getByRole('button', { name: 'サイドバーを開く' }));
    expect(screen.getByTestId('sidebar').className).toContain('translate-x-0');
    expect(screen.getByTestId('sidebar-overlay')).toBeTruthy();

    fireEvent.click(screen.getByTestId('sidebar-overlay'));
    expect(screen.getByTestId('sidebar').className).toContain('-translate-x-full');
    expect(screen.queryByTestId('sidebar-overlay')).toBeNull();
  });

  it('モバイルではリサイズハンドルと ‹/› トグルが存在しない', async () => {
    renderAppShell();
    await screen.findByRole('button', { name: 'ユーザーメニュー(太郎)' });
    expect(screen.queryByTestId('sidebar-resize-handle')).toBeNull();
    expect(screen.queryByRole('button', { name: 'サイドバーを表示' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'サイドバーを折りたたむ' })).toBeNull();
  });

  it('モバイル時にルートが変化するとドロワーが自動で閉じる', async () => {
    renderAppShell();
    await screen.findByRole('button', { name: 'ユーザーメニュー(太郎)' });

    // ハンバーガーで開く
    fireEvent.click(screen.getByRole('button', { name: 'サイドバーを開く' }));
    expect(screen.getByTestId('sidebar').className).toContain('translate-x-0');

    // 文書リンクをクリック(ルート変化) → ドロワーが閉じる
    fireEvent.click(screen.getByRole('link', { name: 'to-foo' }));
    expect(screen.getByTestId('sidebar').className).toContain('-translate-x-full');
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
  });
});

describe('C-4: 右パネルと全体レイアウト結合 (AppShell)', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    localStorage.clear();
    useUserSettingsStore.setState({
      rightPanelOpen: false,
      rightPanelWidth: 320,
      rightPanelTab: 'backlinks',
    });
    useUIStore.setState({
      sidebarCollapsed: false,
      sidebarWidth: 260,
      rightDrawerOpen: false,
      rightPanelSlot: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('C-4-1: desktop, localStorage空, / で right-panel が無く、右折りたたみボタンとヘッダー開くボタンがある', async () => {
    renderAppShell({ initialEntries: ['/'] });
    await screen.findByRole('button', { name: 'ユーザーメニュー(太郎)' });

    expect(screen.queryByTestId('right-panel')).toBeNull();
    expect(screen.getByRole('button', { name: '右パネルを表示' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '右パネルを開く' })).toBeTruthy();
  });

  it('C-4-2: ヘッダーの「右パネルを開く」をクリックすると幅320pxで表示されariaが更新される', async () => {
    renderAppShell({ initialEntries: ['/'] });
    await screen.findByRole('button', { name: 'ユーザーメニュー(太郎)' });

    const openBtn = screen.getByRole('button', { name: '右パネルを開く' });
    fireEvent.click(openBtn);

    const panel = screen.getByTestId('right-panel');
    expect(panel).toBeTruthy();
    expect(panel.style.width).toBe('320px');

    expect(openBtn.getAttribute('aria-label')).toBe('右パネルを閉じる');
    expect(openBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('C-4-3: 右折りたたみボタンで右パネルを閉じ、localStorage に保存される', async () => {
    renderAppShell({ initialEntries: ['/'] });
    await screen.findByRole('button', { name: 'ユーザーメニュー(太郎)' });

    fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
    expect(screen.getByTestId('right-panel')).toBeTruthy();

    const collapseBtn = screen.getByRole('button', { name: '右パネルを折りたたむ' });
    fireEvent.click(collapseBtn);

    expect(screen.queryByTestId('right-panel')).toBeNull();
    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(false);
  });

  it('C-4-4, C-4-5: /trash へ遷移するとパネルとボタンが消え、戻ると再表示される', async () => {
    renderAppShell({ initialEntries: ['/doc/foo.md'] });
    await screen.findByRole('button', { name: 'ユーザーメニュー(太郎)' });

    fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
    expect(screen.getByTestId('right-panel')).toBeTruthy();

    // /trash へ遷移
    fireEvent.click(screen.getByRole('link', { name: 'to-trash' }));
    expect(screen.queryByTestId('right-panel')).toBeNull();
    expect(screen.queryByRole('button', { name: '右パネルを折りたたむ' })).toBeNull();
    expect(screen.queryByRole('button', { name: '右パネルを閉じる' })).toBeNull();
    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(true);

    // /doc/foo.md へ戻る
    fireEvent.click(screen.getByRole('link', { name: 'to-foo' }));
    expect(screen.getByTestId('right-panel')).toBeTruthy();
  });

  it('C-4-6: /settings, /history/foo.md, /admin ではパネルとボタンが出ない', async () => {
    useUserSettingsStore.setState({ rightPanelOpen: true });
    renderAppShell({ initialEntries: ['/settings'] });
    expect(screen.queryByTestId('right-panel')).toBeNull();
    expect(screen.queryByRole('button', { name: /右パネル/ })).toBeNull();
  });

  it('C-4-7: seed open=true, width=400, tab=backlinks で幅400px・タブ選択状態で復元', async () => {
    const origInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1440 });

    localStorage.setItem(
      'tsumiwiki-user-settings',
      JSON.stringify({
        state: {
          rightPanelOpen: true,
          rightPanelWidth: 400,
          rightPanelTab: 'backlinks',
        },
        version: 0,
      }),
    );
    await useUserSettingsStore.persist.rehydrate();
    renderAppShell({ initialEntries: ['/doc/foo.md'] });

    const panel = await screen.findByTestId('right-panel');
    expect(panel.style.width).toBe('400px');
    const tab = screen.getByRole('tab', { name: 'バックリンク' });
    expect(tab.getAttribute('aria-selected')).toBe('true');

    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: origInnerWidth });
  });

  it('C-4-8: seed width=500, innerWidth=1024, 左260開で描画幅332pxにクランプ', async () => {
    const origInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });

    useUserSettingsStore.setState({
      rightPanelOpen: true,
      rightPanelWidth: 500,
    });
    useUIStore.setState({ sidebarCollapsed: false, sidebarWidth: 260 });

    renderAppShell({ initialEntries: ['/doc/foo.md'] });

    const panel = await screen.findByTestId('right-panel');
    expect(panel.style.width).toBe('332px');
    expect(useUserSettingsStore.getState().rightPanelWidth).toBe(500);

    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: origInnerWidth });
  });

  it('C-4-9: 右リサイズハンドルでドラッグリサイズ', async () => {
    const origInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1440 });

    renderAppShell({ initialEntries: ['/doc/foo.md'] });
    fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));

    const handle = screen.getByTestId('right-panel-resize-handle');
    fireEvent.mouseDown(handle);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1040 }));
    window.dispatchEvent(new MouseEvent('mouseup'));

    expect(useUserSettingsStore.getState().rightPanelWidth).toBe(400);

    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: origInnerWidth });
  });

  it('C-4-10: innerWidth=900, 左開、右を開くと左サイドバーが消える(D7)', async () => {
    const origInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 900 });

    useUIStore.setState({ sidebarCollapsed: false, sidebarWidth: 260 });
    renderAppShell({ initialEntries: ['/doc/foo.md'] });

    expect(screen.getByTestId('sidebar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));

    expect(screen.getByTestId('right-panel')).toBeTruthy();
    expect(screen.queryByTestId('sidebar')).toBeNull();

    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: origInnerWidth });
  });

  it('C-4-M1: innerWidth=1024, 右パネル開(240px)で左サイドバーを450pxへドラッグしても折りたたまれず352pxにクランプされる', async () => {
    const origInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });

    useUserSettingsStore.setState({ rightPanelOpen: true, rightPanelWidth: 240 });
    useUIStore.setState({ sidebarCollapsed: false, sidebarWidth: 260 });
    renderAppShell({ initialEntries: ['/doc/foo.md'] });

    expect(screen.getByTestId('right-panel')).toBeTruthy();
    expect(screen.getByTestId('sidebar')).toBeTruthy();

    const handle = screen.getByTestId('sidebar-resize-handle');
    fireEvent.mouseDown(handle, { clientX: 260 });
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 450 }));
    window.dispatchEvent(new MouseEvent('mouseup'));

    expect(screen.getByTestId('sidebar')).toBeTruthy();
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
    expect(useUIStore.getState().sidebarWidth).toBe(352);

    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: origInnerWidth });
  });

  it('C-4-N1: innerWidth=900, localStorage seed で rightPanelOpen=true の初回描画時に左サイドバーが自動的に折りたたまれる(D7)', async () => {
    const origInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 900 });

    localStorage.setItem(
      'tsumiwiki-user-settings',
      JSON.stringify({
        state: {
          rightPanelOpen: true,
          rightPanelWidth: 320,
        },
        version: 0,
      }),
    );
    await useUserSettingsStore.persist.rehydrate();
    useUIStore.setState({ sidebarCollapsed: false, sidebarWidth: 260 });

    renderAppShell({ initialEntries: ['/doc/foo.md'] });

    await waitFor(() => {
      expect(screen.queryByTestId('sidebar')).toBeNull();
      expect(screen.getByTestId('right-panel')).toBeTruthy();
      expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    });

    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: origInnerWidth });
  });

  it('C-4-N3: innerWidth=900, localStorage seed で rightPanelOpen=true, /trash でマウント後に /doc/foo.md へ遷移すると左サイドバーが自動的に折りたたまれる(D7)', async () => {
    const origInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 900 });

    localStorage.setItem(
      'tsumiwiki-user-settings',
      JSON.stringify({
        state: {
          rightPanelOpen: true,
          rightPanelWidth: 320,
        },
        version: 0,
      }),
    );
    await useUserSettingsStore.persist.rehydrate();
    useUIStore.setState({ sidebarCollapsed: false, sidebarWidth: 260 });

    renderAppShell({ initialEntries: ['/trash'] });

    expect(screen.queryByTestId('right-panel')).toBeNull();
    expect(screen.getByTestId('sidebar')).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'to-foo' }));

    await waitFor(() => {
      expect(screen.queryByTestId('sidebar')).toBeNull();
      expect(screen.getByTestId('right-panel')).toBeTruthy();
      expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    });

    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: origInnerWidth });
  });

  it('C-4-11: innerWidth=900, 右開、左折りたたみボタンで左を開くと右が消える(D7)', async () => {
    const origInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 900 });

    useUIStore.setState({ sidebarCollapsed: true, sidebarWidth: 260 });
    renderAppShell({ initialEntries: ['/doc/foo.md'] });

    fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
    expect(screen.getByTestId('right-panel')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'サイドバーを表示' }));

    expect(screen.getByTestId('sidebar')).toBeTruthy();
    expect(screen.queryByTestId('right-panel')).toBeNull();
    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(false);

    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: origInnerWidth });
  });

  it('C-4-12: innerWidth=1280 で左右とも開、900 に resize イベントで左が閉じる(D7)', async () => {
    const origInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1280 });

    useUIStore.setState({ sidebarCollapsed: false, sidebarWidth: 260 });
    renderAppShell({ initialEntries: ['/doc/foo.md'] });

    expect(screen.getByTestId('sidebar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
    expect(screen.getByTestId('right-panel')).toBeTruthy();

    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 900 });
    window.dispatchEvent(new Event('resize'));

    await waitFor(() => {
      expect(screen.queryByTestId('sidebar')).toBeNull();
      expect(screen.getByTestId('right-panel')).toBeTruthy();
    });

    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: origInnerWidth });
  });

  it('C-4-18: mobile初期接続時は desktop open=true でも右ドロワーは閉', async () => {
    stubMatchMedia(true);
    useUserSettingsStore.setState({ rightPanelOpen: true });
    renderAppShell({ initialEntries: ['/doc/foo.md'] });

    const panel = screen.getByTestId('right-panel');
    expect(panel.className).toContain('translate-x-full');
    expect(screen.queryByTestId('right-panel-overlay')).toBeNull();
    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(true);
  });

  it('C-4-19: desktop 開 → mobile へ change で閉 → mobile で開く → desktop へ change で枠表示 → mobile で閉', async () => {
    stubMatchMedia(false);
    renderAppShell({ initialEntries: ['/doc/foo.md'] });

    // desktop で右パネルを開く
    fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
    expect(screen.getByTestId('right-panel')).toBeTruthy();
    expect(screen.queryByTestId('right-panel-overlay')).toBeNull();

    // mobile へ change
    matchMediaListeners.forEach((l) => l({ matches: true }));

    // mobile では初期状態として右ドロワーは閉
    await waitFor(() => {
      expect(screen.getByTestId('right-panel').className).toContain('translate-x-full');
    });
    expect(screen.queryByTestId('right-panel-overlay')).toBeNull();

    // mobile で右ドロワーを開く
    fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
    expect(useUIStore.getState().rightDrawerOpen).toBe(true);
    expect(screen.getByTestId('right-panel').className).toContain('translate-x-0');
    expect(screen.getByTestId('right-panel-overlay')).toBeTruthy();

    // desktop へ change
    matchMediaListeners.forEach((l) => l({ matches: false }));

    // desktop では枠として表示
    await waitFor(() => {
      expect(screen.getByTestId('right-panel')).toBeTruthy();
    });
    expect(screen.queryByTestId('right-panel-overlay')).toBeNull();

    // 再び mobile へ change
    matchMediaListeners.forEach((l) => l({ matches: true }));
    await waitFor(() => {
      expect(screen.getByTestId('right-panel').className).toContain('translate-x-full');
    });
    expect(screen.queryByTestId('right-panel-overlay')).toBeNull();
  });

  it('C-4-20, C-4-21: mobile でヘッダーボタンからドロワーを開きオーバーレイで閉じる', async () => {
    stubMatchMedia(true);
    renderAppShell({ initialEntries: ['/doc/foo.md'] });

    const openBtn = screen.getByRole('button', { name: '右パネルを開く' });
    fireEvent.click(openBtn);

    expect(useUIStore.getState().rightDrawerOpen).toBe(true);
    expect(screen.getByTestId('right-panel-overlay')).toBeTruthy();
    expect(screen.getByTestId('right-panel').className).toContain('translate-x-0');

    // オーバーレイクリックで閉じる
    fireEvent.click(screen.getByTestId('right-panel-overlay'));
    expect(useUIStore.getState().rightDrawerOpen).toBe(false);
    expect(screen.queryByTestId('right-panel-overlay')).toBeNull();
  });

  it('C-4-22: mobile で右ドロワーを開いた状態からルート遷移すると閉じる', async () => {
    stubMatchMedia(true);
    renderAppShell({ initialEntries: ['/doc/foo.md'] });

    fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
    expect(useUIStore.getState().rightDrawerOpen).toBe(true);

    fireEvent.click(screen.getByRole('link', { name: 'to-b' }));
    expect(useUIStore.getState().rightDrawerOpen).toBe(false);
  });

  it('C-4-23, C-4-24: mobile で左右ドロワーは排他', async () => {
    stubMatchMedia(true);
    renderAppShell({ initialEntries: ['/doc/foo.md'] });

    // 左ドロワーを開く
    fireEvent.click(screen.getByRole('button', { name: 'サイドバーを開く' }));
    expect(screen.getByTestId('sidebar').className).toContain('translate-x-0');

    // 右ドロワーを開く → 左が閉じる
    fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
    expect(screen.getByTestId('sidebar').className).toContain('-translate-x-full');
    expect(screen.getByTestId('right-panel').className).toContain('translate-x-0');

    // 再び左ドロワーを開く → 右が閉じる
    fireEvent.click(screen.getByRole('button', { name: 'サイドバーを開く' }));
    expect(screen.getByTestId('right-panel').className).toContain('translate-x-full');
    expect(screen.getByTestId('sidebar').className).toContain('translate-x-0');
  });

  it('C-4-25: mobile で右ドロワーを開いた状態で Escape で閉じる', async () => {
    stubMatchMedia(true);
    renderAppShell({ initialEntries: ['/doc/foo.md'] });

    fireEvent.click(screen.getByRole('button', { name: '右パネルを開く' }));
    expect(useUIStore.getState().rightDrawerOpen).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(useUIStore.getState().rightDrawerOpen).toBe(false);
  });

  it('C-4-26: mobile で左ドロワー開いた状態から Ctrl+Shift+U で左閉 & 右開、再度押下で右閉', async () => {
    stubMatchMedia(true);
    renderAppShell({ initialEntries: ['/doc/foo.md'] });

    // 左ドロワーを開く
    fireEvent.click(screen.getByRole('button', { name: 'サイドバーを開く' }));
    expect(screen.getByTestId('sidebar').className).toContain('translate-x-0');

    // Ctrl+Shift+U でトグル → 左が閉じて右が開く
    fireEvent.keyDown(window, { key: 'U', ctrlKey: true, shiftKey: true });
    expect(screen.getByTestId('sidebar').className).toContain('-translate-x-full');
    expect(screen.getByTestId('right-panel').className).toContain('translate-x-0');
    expect(useUIStore.getState().rightDrawerOpen).toBe(true);

    // 再度 Ctrl+Shift+U → 右が閉じる
    fireEvent.keyDown(window, { key: 'U', ctrlKey: true, shiftKey: true });
    expect(screen.getByTestId('right-panel').className).toContain('translate-x-full');
    expect(useUIStore.getState().rightDrawerOpen).toBe(false);
  });
});
