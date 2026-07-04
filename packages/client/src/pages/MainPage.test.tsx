import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MainPage } from './MainPage';

function ParamsProbe() {
  const params = useParams();
  return <div data-testid="params-probe">{params['*']}</div>;
}

const CURRENT_USER = { id: 1, username: 'taro', displayName: '太郎', role: 'user', disabled: false };

function stubFetch(overrides: Record<string, unknown> = {}) {
  const fetchMock = vi.fn((url: string) => {
    const [path] = url.split('?');
    if (path === '/api/auth/me') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ user: CURRENT_USER }) });
    }
    if (key(path) in overrides) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(overrides[key(path)]) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function key(path: string): string {
  return `GET ${path}`;
}

function renderMainPage(initialPath = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/" element={<MainPage />} />
          <Route path="/doc/*" element={<ParamsProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MainPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('文書未選択時に最近更新した文書の一覧を表示する', async () => {
    stubFetch({
      'GET /api/docs/recent': {
        docs: [
          { path: '議事録.md', title: '議事録', folder: '', updatedAt: '2026-07-01T00:00:00+09:00' },
        ],
      },
    });

    renderMainPage();

    expect(await screen.findByText('最近更新した文書')).toBeTruthy();
    expect(await screen.findByText('議事録')).toBeTruthy();
  });

  it('一覧が空のときは「文書がありません」を表示する', async () => {
    stubFetch({ 'GET /api/docs/recent': { docs: [] } });

    renderMainPage();

    expect(await screen.findByText('文書がありません')).toBeTruthy();
  });

  it('一覧の項目をクリックすると文書へ遷移する', async () => {
    stubFetch({
      'GET /api/docs/recent': {
        docs: [
          { path: '議事録.md', title: '議事録', folder: '', updatedAt: '2026-07-01T00:00:00+09:00' },
        ],
      },
    });

    renderMainPage();

    fireEvent.click(await screen.findByText('議事録'));

    const probe = await screen.findByTestId('params-probe');
    expect(probe.textContent).toBe('議事録.md');
  });
});
