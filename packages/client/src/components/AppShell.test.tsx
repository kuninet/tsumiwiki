import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '../stores/ui';
import { AppShell } from './AppShell';

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
            <Route index element={<div>本文</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AppShell', () => {
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
});
