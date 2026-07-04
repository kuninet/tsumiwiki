import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

// エディタ本体の検証はroundtrip.test.tsで行うため、Appのテストではモックする
vi.mock('./editor/EditorDemo', () => ({
  EditorDemo: () => <div data-testid="editor-demo-mock" />,
}));

import { App } from './App';

function renderApp(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('App', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('未認証状態で保護ルートへアクセスするとログイン画面へリダイレクトする', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () =>
          Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'ログインが必要です' } }),
      }),
    );

    renderApp('/');
    expect(await screen.findByLabelText('ユーザーID')).toBeTruthy();
  });

  it('認証済み状態で / にアクセスするとメイン画面を表示する', async () => {
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
        if (url.startsWith('/api/docs/recent')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ docs: [] }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ tags: [] }) });
      }),
    );

    renderApp('/');
    expect(await screen.findByText('最近更新した文書')).toBeTruthy();
  });
});
