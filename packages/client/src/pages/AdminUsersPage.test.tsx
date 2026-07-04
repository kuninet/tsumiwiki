import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { User } from '@tsumiwiki/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminUsersPage } from './AdminUsersPage';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const ADMIN: User = { id: 1, username: 'admin', displayName: '管理者太郎', role: 'admin', disabled: false };
const MEMBER: User = { id: 2, username: 'taro', displayName: '太郎', role: 'user', disabled: false };

function stubFetch(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const [path] = url.split('?');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });

    if (path === '/api/auth/me') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ user: ADMIN }) });
    }
    const key = `${method} ${path}`;
    if (key in overrides) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(overrides[key]) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ users: [ADMIN, MEMBER] }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminUsersPage />
    </QueryClientProvider>,
  );
}

describe('AdminUsersPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('ユーザー一覧を表示する', async () => {
    stubFetch();
    renderPage();

    expect(await screen.findByText('admin')).toBeTruthy();
    expect(screen.getByText('taro')).toBeTruthy();
    expect(screen.getByText('管理者')).toBeTruthy();
  });

  it('追加フォームで空のユーザーIDは検証エラーになりAPIを呼ばない', async () => {
    const calls = stubFetch();
    renderPage();
    await screen.findByText('admin');

    fireEvent.click(screen.getByRole('button', { name: 'ユーザー追加' }));
    fireEvent.click(screen.getByRole('button', { name: '追加' }));

    expect(await screen.findByTestId('create-user-error')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/users')).toBe(false);
  });

  it('追加フォームで不正なユーザーID(半角英数と_.-以外)は検証エラーになる', async () => {
    const calls = stubFetch();
    renderPage();
    await screen.findByText('admin');

    fireEvent.click(screen.getByRole('button', { name: 'ユーザー追加' }));
    fireEvent.change(screen.getByLabelText('ユーザーID'), { target: { value: '不正 ID' } });
    fireEvent.change(screen.getByLabelText('表示名'), { target: { value: '次郎' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: '追加' }));

    expect(await screen.findByTestId('create-user-error')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/users')).toBe(false);
  });

  it('正しい入力では追加APIを呼び出す', async () => {
    const calls = stubFetch({ 'POST /api/users': { user: { ...MEMBER, id: 3, username: 'jiro' } } });
    renderPage();
    await screen.findByText('admin');

    fireEvent.click(screen.getByRole('button', { name: 'ユーザー追加' }));
    fireEvent.change(screen.getByLabelText('ユーザーID'), { target: { value: 'jiro' } });
    fireEvent.change(screen.getByLabelText('表示名'), { target: { value: '次郎' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: '追加' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/users')).toBe(true);
    });
  });

  it('自分自身の行では降格・無効化ボタンが無効化される', async () => {
    stubFetch();
    renderPage();

    const adminRow = (await screen.findByText('admin')).closest('tr')!;
    expect(within(adminRow).getByRole('button', { name: '降格' }) as HTMLButtonElement).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(adminRow).getByRole('button', { name: '無効化' }) as HTMLButtonElement).toHaveProperty(
      'disabled',
      true,
    );

    const memberRow = screen.getByText('taro').closest('tr')!;
    expect(within(memberRow).getByRole('button', { name: '昇格' }) as HTMLButtonElement).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('他ユーザーの無効化は確認ダイアログを経てPATCHを呼び出す', async () => {
    const calls = stubFetch({ 'PATCH /api/users/2': { user: { ...MEMBER, disabled: true } } });
    renderPage();

    const memberRow = (await screen.findByText('taro')).closest('tr')!;
    fireEvent.click(within(memberRow).getByRole('button', { name: '無効化' }));

    expect(await screen.findByText(/無効化します/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '無効化する' }));

    await waitFor(() => {
      const patchCall = calls.find((c) => c.method === 'PATCH' && c.path === '/api/users/2');
      expect(patchCall).toBeTruthy();
      expect(patchCall?.body).toMatchObject({ disabled: true });
    });
  });
});
