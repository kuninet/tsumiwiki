import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ME_QUERY_KEY } from '../api/auth';
import { DocTab } from './DocTab';

const CURRENT_USER = {
  id: 1,
  username: 'test',
  displayName: 'テストユーザー',
  role: 'user',
  disabled: false,
};

function renderDocTab(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  queryClient.setQueryData(ME_QUERY_KEY, CURRENT_USER);

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/doc/${path}`]}>
        <DocTab path={path} active />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DocTab エラーハンドリング (#321)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('404 NOT_FOUND の場合に「指定された文書が見つかりません」と表示される', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          json: () =>
            Promise.resolve({
              error: { code: 'NOT_FOUND', message: '文書が見つかりません' },
            }),
        }),
      ),
    );

    renderDocTab('notfound.md');

    await waitFor(() => {
      expect(screen.getByText('指定された文書が見つかりません')).toBeTruthy();
    });
  });

  it('400 INVALID_PATH の場合に「指定された文書が見つかりません」と表示される', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: () =>
            Promise.resolve({
              error: { code: 'INVALID_PATH', message: 'パスが不正です' },
            }),
        }),
      ),
    );

    renderDocTab('invalid_path');

    await waitFor(() => {
      expect(screen.getByText('指定された文書が見つかりません')).toBeTruthy();
    });
  });

  it('その他のエラー (500) では「文書の取得に失敗しました」と表示される', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () =>
            Promise.resolve({
              error: { code: 'INTERNAL_ERROR', message: 'サーバーエラー' },
            }),
        }),
      ),
    );

    renderDocTab('error.md');

    await waitFor(() => {
      expect(screen.getByText('文書の取得に失敗しました')).toBeTruthy();
    });
  });
});
