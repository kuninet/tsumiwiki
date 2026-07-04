import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

function renderLoginPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LoginPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('ユーザーIDとパスワードを入力して送信するとログインAPIを呼び出す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          user: { id: 1, username: 'taro', displayName: '太郎', role: 'user', disabled: false },
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderLoginPage();
    fireEvent.change(screen.getByLabelText('ユーザーID'), { target: { value: 'taro' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/login',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('ログイン失敗時にAPIのエラーメッセージを表示する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () =>
          Promise.resolve({
            error: { code: 'UNAUTHORIZED', message: 'ユーザーIDまたはパスワードが違います' },
          }),
      }),
    );

    renderLoginPage();
    fireEvent.change(screen.getByLabelText('ユーザーID'), { target: { value: 'taro' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));

    const errorEl = await screen.findByTestId('login-error');
    expect(errorEl.textContent).toContain('ユーザーIDまたはパスワードが違います');
  });
});
