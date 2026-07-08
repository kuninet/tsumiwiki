import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function renderAppShell() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
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
