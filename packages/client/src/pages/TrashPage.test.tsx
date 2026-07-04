import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { User } from '@tsumiwiki/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrashPage } from './TrashPage';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const ENTRIES = [
  {
    trashPath: '.trash/古い文書.md',
    name: '古い文書.md',
    isFolder: false,
    originalPath: 'フォルダ/古い文書.md',
    deletedAt: '2026-07-01T00:00:00+09:00',
    deletedBy: '太郎',
  },
];

const NORMAL_USER: User = { id: 1, username: 'taro', displayName: '太郎', role: 'user', disabled: false };
const ADMIN_USER: User = { id: 2, username: 'admin', displayName: '管理者', role: 'admin', disabled: false };

function stubFetch(user: User, overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const [path] = url.split('?');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });

    if (path === '/api/auth/me') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ user }) });
    }
    const key = `${method} ${path}`;
    if (key in overrides) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(overrides[key]) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ entries: ENTRIES }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function renderTrashPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TrashPage />
    </QueryClientProvider>,
  );
}

describe('TrashPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('ごみ箱の一覧を表示する', async () => {
    stubFetch(NORMAL_USER);
    renderTrashPage();

    expect(await screen.findByText('古い文書.md')).toBeTruthy();
    expect(screen.getByText('太郎')).toBeTruthy();
  });

  it('空のときは「ごみ箱は空です」を表示する', async () => {
    stubFetch(NORMAL_USER, { 'GET /api/trash': { entries: [] } });
    renderTrashPage();

    expect(await screen.findByText('ごみ箱は空です')).toBeTruthy();
  });

  it('復元ボタンでPOST /api/trash/restoreを呼ぶ', async () => {
    const calls = stubFetch(NORMAL_USER);
    renderTrashPage();

    fireEvent.click(await screen.findByRole('button', { name: '復元' }));

    await waitFor(() => {
      const restoreCall = calls.find((c) => c.method === 'POST' && c.path === '/api/trash/restore');
      expect(restoreCall).toBeTruthy();
      expect(restoreCall?.body).toMatchObject({ trashPath: '.trash/古い文書.md' });
    });
  });

  it('一般ユーザーには完全削除ボタンが表示されない', async () => {
    stubFetch(NORMAL_USER);
    renderTrashPage();

    await screen.findByText('古い文書.md');
    expect(screen.queryByRole('button', { name: '完全削除' })).toBeNull();
  });

  it('adminには完全削除ボタンが表示され、確認ダイアログを経てDELETE /api/trashを呼ぶ', async () => {
    const calls = stubFetch(ADMIN_USER);
    renderTrashPage();

    fireEvent.click(await screen.findByRole('button', { name: '完全削除' }));

    expect(await screen.findByText(/元に戻せません/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/trash')).toBe(true);
    });
  });
});
