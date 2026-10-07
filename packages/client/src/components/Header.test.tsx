import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditStore } from '../stores/edit';
import { useUIStore } from '../stores/ui';
import { useUserSettingsStore } from '../stores/user-settings';
import { Header } from './Header';

function stubFetch(overrides: Record<string, unknown> = {}) {
  const fetchMock = vi.fn((url: string) => {
    const [path] = url.split('?');
    if (path === '/api/auth/me') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            user: { id: 1, username: 'taro', displayName: '太郎', role: 'user', disabled: false },
          }),
      });
    }
    const key = `GET ${path}`;
    if (key in overrides) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(overrides[key]) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ results: [] }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderHeader(initialEntries = ['/']) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/" element={<Header />} />
          <Route path="/doc/*" element={<Header />} />
          <Route path="/login" element={<div>ログイン画面</div>} />
          <Route path="/settings" element={<Header />} />
          <Route path="/trash" element={<Header />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Header', () => {
  beforeEach(() => {
    useUserSettingsStore.setState({ rightPanelOpen: false });
    useUIStore.setState({ rightDrawerOpen: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    useEditStore.setState({ mode: 'view' });
  });

  it('Ctrl+Kで検索ボックスにフォーカスする(非編集時)', async () => {
    stubFetch();
    renderHeader();
    await screen.findByRole('button', { name: /ユーザーメニュー/ });

    const input = screen.getByPlaceholderText('検索');
    expect(document.activeElement).not.toBe(input);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    expect(document.activeElement).toBe(input);
  });

  it('編集モード中はCtrl+Kで検索ボックスへフォーカスしない', async () => {
    stubFetch();
    useEditStore.setState({ mode: 'edit' });
    renderHeader();
    await screen.findByRole('button', { name: /ユーザーメニュー/ });

    const input = screen.getByPlaceholderText('検索');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    expect(document.activeElement).not.toBe(input);
  });

  it('ユーザーメニューからログアウトを実行するとログイン画面へ遷移する', async () => {
    stubFetch();
    renderHeader();

    fireEvent.click(await screen.findByRole('button', { name: /ユーザーメニュー/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'ログアウト' }));

    await waitFor(async () => {
      expect(await screen.findByText('ログイン画面')).toBeTruthy();
    });
  });

  it('更新確認ボタンをクリックするとライブラリ再スキャンAPIを呼ぶ', async () => {
    const fetchMock = stubFetch();
    renderHeader();
    await screen.findByRole('button', { name: /ユーザーメニュー/ });

    fireEvent.click(screen.getByRole('button', { name: '更新確認' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/library/rescan',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('MainPageルート(/, /doc/*)では右パネル開閉ボタンが表示されトグルできる(#271)', async () => {
    stubFetch();
    renderHeader(['/doc/a.md']);
    await screen.findByRole('button', { name: /ユーザーメニュー/ });

    const toggleBtn = screen.getByRole('button', { name: '右パネルを開く' });
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggleBtn);
    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(true);
    expect(toggleBtn.getAttribute('aria-label')).toBe('右パネルを閉じる');
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('MainPage以外のルート(/settings, /trash)では右パネル開閉ボタンが表示されない(#271)', async () => {
    stubFetch();
    renderHeader(['/settings']);
    await screen.findByRole('button', { name: /ユーザーメニュー/ });

    expect(screen.queryByRole('button', { name: /右パネル/ })).toBeNull();
  });
});
