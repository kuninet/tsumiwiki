import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAdmin } from './RequireAdmin';
import { RequireAuth } from './RequireAuth';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderWithUser(role: 'admin' | 'user') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          user: { id: 1, username: 'u', displayName: 'ユーザー', role, disabled: false },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/users']}>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/" element={<div>ホーム</div>} />
            <Route element={<RequireAdmin />}>
              <Route path="/admin/users" element={<div>管理画面</div>} />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RequireAdmin', () => {
  it('adminは管理画面を表示できる', async () => {
    renderWithUser('admin');
    await waitFor(() => expect(screen.getByText('管理画面')).toBeTruthy());
  });

  it('一般ユーザーはホームへリダイレクトされる', async () => {
    renderWithUser('user');
    await waitFor(() => expect(screen.getByText('ホーム')).toBeTruthy());
    expect(screen.queryByText('管理画面')).toBeNull();
  });
});
