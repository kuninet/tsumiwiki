import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '../stores/ui';
import { AppShell } from './AppShell';

function stubMatchMedia(matches: boolean) {
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

function renderAppShell(byDateHandler?: (body: unknown) => { status: number; json: unknown }) {
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
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route
              index
              element={
                <div>
                  <Link to="/doc/foo.md">to-foo</Link>
                  <div>本文</div>
                </div>
              }
            />
            <Route path="doc/*" element={<div>文書</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AppShell (デスクトップ)', () => {
  beforeEach(() => {
    stubMatchMedia(false); // 広幅 = デスクトップ扱い
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
    renderAppShell(byDateHandler);
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
    renderAppShell(byDateHandler);
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
    renderAppShell(byDateHandler);
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
    useUIStore.setState({ sidebarCollapsed: false });
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
