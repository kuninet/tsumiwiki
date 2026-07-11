import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LIBRARY_SETTINGS_DEFAULTS } from '@tsumiwiki/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibrarySettingsPage } from './LibrarySettingsPage';

// #99: settings.yaml が壊れているとき、admin に対して警告バナーを出し、
//      手動修復後にキャッシュを更新する導線(再読込ボタン)を提供する。
//      サーバーが GET /api/library/settings で返す corrupted フラグに基づく。

interface Call {
  method: string;
  path: string;
}

function stubFetch(corrupted: boolean) {
  const calls: Call[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const [path] = url.split('?');
    calls.push({ method, path });

    if (path === '/api/auth/me') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            user: { id: 1, username: 'admin', displayName: '管理者', role: 'admin', disabled: false },
          }),
      });
    }
    if (path === '/api/library/settings') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ settings: LIBRARY_SETTINGS_DEFAULTS, corrupted }),
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LibrarySettingsPage />
    </QueryClientProvider>,
  );
}

describe('LibrarySettingsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('corrupted: false のとき警告バナーは表示されない', async () => {
    stubFetch(false);
    renderPage();

    // 設定フォームが読み込まれるまで待つ(バナーの非表示を確認する前段)
    await waitFor(() => {
      expect(screen.getByPlaceholderText('_templates')).toBeTruthy();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: '再読込' })).toBeNull();
  });

  it('corrupted: true のとき warning バナー(role="alert")と警告文言・再読込ボタンが表示される', async () => {
    stubFetch(true);
    renderPage();

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('設定ファイル');
    expect(banner.textContent).toContain('.tsumiwiki/settings.yaml');
    expect(banner.textContent).toContain('表示されているのは初期値です');
    expect(banner.textContent).toContain('git 上の正しい過去版が上書きされます');
    expect(screen.getByRole('button', { name: '再読込' })).toBeTruthy();
  });

  it('再読込ボタンを押すと /api/library/settings が再取得される', async () => {
    const calls = stubFetch(true);
    renderPage();

    await screen.findByRole('alert');
    // 初回のGET(auth.me も含む)が完了するまで待つ
    await waitFor(() => {
      expect(calls.filter((c) => c.path === '/api/library/settings').length).toBeGreaterThanOrEqual(1);
    });
    const before = calls.filter((c) => c.path === '/api/library/settings').length;

    fireEvent.click(screen.getByRole('button', { name: '再読込' }));

    // invalidateQueries → 再fetch が走ることを検証(呼び出し回数の増加)
    await waitFor(() => {
      const after = calls.filter((c) => c.path === '/api/library/settings').length;
      expect(after).toBeGreaterThan(before);
    });
  });
});
