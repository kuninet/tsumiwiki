import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEditStore } from '../stores/edit';
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

function ParamsProbe() {
  const params = useParams();
  return <div data-testid="params-probe">{params['*']}</div>;
}

function renderHeader() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Header />} />
          <Route path="/login" element={<div>ログイン画面</div>} />
          <Route path="/settings" element={<div>設定画面</div>} />
          <Route path="/doc/*" element={<ParamsProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Header', () => {
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
});
