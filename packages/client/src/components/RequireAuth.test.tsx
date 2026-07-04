import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from './RequireAuth';

function renderWithAuth() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/login" element={<div>ログイン画面</div>} />
          <Route element={<RequireAuth />}>
            <Route path="/" element={<div>保護されたコンテンツ</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RequireAuth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('未認証(me=null)の場合はログイン画面へリダイレクトする', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () =>
          Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'ログインが必要です' } }),
      }),
    );

    renderWithAuth();
    expect(await screen.findByText('ログイン画面')).toBeTruthy();
  });

  it('認証済みの場合は子要素を表示する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            user: { id: 1, username: 'taro', displayName: '太郎', role: 'user', disabled: false },
          }),
      }),
    );

    renderWithAuth();
    expect(await screen.findByText('保護されたコンテンツ')).toBeTruthy();
  });
});
