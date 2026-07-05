import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const CURRENT_USER = { id: 1, username: 'taro', displayName: '太郎', role: 'user' as const, disabled: false };

function stubFetch(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const [path] = url.split('?');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });

    if (path === '/api/auth/me') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ user: CURRENT_USER }) });
    }
    const key = `${method} ${path}`;
    if (key in overrides) {
      const override = overrides[key];
      if (
        typeof override === 'object' &&
        override !== null &&
        'status' in override &&
        'error' in override
      ) {
        const err = override as { status: number; error: { code: string; message: string } };
        return Promise.resolve({ ok: false, status: err.status, json: () => Promise.resolve({ error: err.error }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(override) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

describe('SettingsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('アカウント情報を表示する', async () => {
    stubFetch();
    renderPage();

    expect(await screen.findByText('taro')).toBeTruthy();
    expect(screen.getByText('太郎')).toBeTruthy();
  });

  it('新しいパスワードと確認が一致しない場合はクライアント側エラーを表示しAPIを呼ばない', async () => {
    const calls = stubFetch();
    renderPage();
    await screen.findByText('taro');

    fireEvent.change(screen.getByLabelText('現在のパスワード'), { target: { value: 'old-pass' } });
    fireEvent.change(screen.getByLabelText('新しいパスワード'), { target: { value: 'new-pass' } });
    fireEvent.change(screen.getByLabelText('新しいパスワード(確認)'), { target: { value: '不一致' } });
    fireEvent.click(screen.getByRole('button', { name: '変更する' }));

    expect(await screen.findByTestId('password-error')).toHaveProperty(
      'textContent',
      '新しいパスワードが一致しません',
    );
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/me/password')).toBe(false);
  });

  it('変更に成功するとフォームがクリアされる', async () => {
    stubFetch({ 'PUT /api/me/password': { ok: true } });
    renderPage();
    await screen.findByText('taro');

    const currentInput = screen.getByLabelText('現在のパスワード') as HTMLInputElement;
    const newInput = screen.getByLabelText('新しいパスワード') as HTMLInputElement;
    const confirmInput = screen.getByLabelText('新しいパスワード(確認)') as HTMLInputElement;

    fireEvent.change(currentInput, { target: { value: 'old-pass' } });
    fireEvent.change(newInput, { target: { value: 'new-pass' } });
    fireEvent.change(confirmInput, { target: { value: 'new-pass' } });
    fireEvent.click(screen.getByRole('button', { name: '変更する' }));

    await waitFor(() => {
      expect(currentInput.value).toBe('');
      expect(newInput.value).toBe('');
      expect(confirmInput.value).toBe('');
    });
  });

  it('現在のパスワードが誤っている場合はAPIのエラーメッセージを表示する', async () => {
    stubFetch({
      'PUT /api/me/password': {
        status: 400,
        error: { code: 'VALIDATION_ERROR', message: '現在のパスワードが違います' },
      },
    });
    renderPage();
    await screen.findByText('taro');

    fireEvent.change(screen.getByLabelText('現在のパスワード'), { target: { value: 'wrong' } });
    fireEvent.change(screen.getByLabelText('新しいパスワード'), { target: { value: 'new-pass' } });
    fireEvent.change(screen.getByLabelText('新しいパスワード(確認)'), { target: { value: 'new-pass' } });
    fireEvent.click(screen.getByRole('button', { name: '変更する' }));

    expect(await screen.findByTestId('password-error')).toHaveProperty(
      'textContent',
      '現在のパスワードが違います',
    );
  });
});
