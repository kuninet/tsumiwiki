import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchBox } from './SearchBox';

interface Call {
  method: string;
  path: string;
}

function stubFetch(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const [path] = url.split('?');
    calls.push({ method, path });
    const key = `${method} ${path}`;
    if (key in overrides) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(overrides[key]) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ results: [] }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function ParamsProbe() {
  const params = useParams();
  return <div data-testid="params-probe">{params['*']}</div>;
}

function renderSearchBox() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<SearchBox />} />
          <Route path="/doc/*" element={<ParamsProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SearchBox', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    cleanup();
  });

  it('入力後300ms経過するまでは検索APIを呼ばず、経過後に呼び出す', async () => {
    vi.useFakeTimers();
    const calls = stubFetch();
    renderSearchBox();

    fireEvent.change(screen.getByPlaceholderText('検索'), { target: { value: '議事録' } });
    expect(calls.some((c) => c.path === '/api/search')).toBe(false);

    await vi.advanceTimersByTimeAsync(300);

    expect(calls.some((c) => c.path === '/api/search')).toBe(true);
  });

  it('検索結果を表示する', async () => {
    stubFetch({
      'GET /api/search': {
        results: [{ path: '議事録.md', title: '議事録', snippet: '本日の<mark>議事録</mark>です' }],
      },
    });
    renderSearchBox();

    fireEvent.change(screen.getByPlaceholderText('検索'), { target: { value: '議事録' } });

    expect(await screen.findByText('議事録', { selector: 'div' })).toBeTruthy();
  });

  it('snippetの<mark>タグをHTMLとして描画する', async () => {
    stubFetch({
      'GET /api/search': {
        results: [{ path: '議事録.md', title: '議事録', snippet: '本日の<mark>議事録</mark>です' }],
      },
    });
    renderSearchBox();

    fireEvent.change(screen.getByPlaceholderText('検索'), { target: { value: '議事録' } });

    await waitFor(() => {
      const mark = document.querySelector('mark');
      expect(mark).toBeTruthy();
      expect(mark?.textContent).toBe('議事録');
    });
  });

  it('結果をクリックすると文書へ遷移しドロップダウンが閉じる', async () => {
    stubFetch({
      'GET /api/search': {
        results: [{ path: '議事録.md', title: '議事録', snippet: '本日の<mark>議事録</mark>です' }],
      },
    });
    renderSearchBox();

    fireEvent.change(screen.getByPlaceholderText('検索'), { target: { value: '議事録' } });

    fireEvent.click(await screen.findByText('議事録', { selector: 'div' }));

    const probe = await screen.findByTestId('params-probe');
    expect(probe.textContent).toBe('議事録.md');
  });

  it('Escapeキーでドロップダウンが閉じる', async () => {
    stubFetch({
      'GET /api/search': {
        results: [{ path: '議事録.md', title: '議事録', snippet: '本日の<mark>議事録</mark>です' }],
      },
    });
    renderSearchBox();

    const input = screen.getByPlaceholderText('検索');
    fireEvent.change(input, { target: { value: '議事録' } });
    await screen.findByText('議事録', { selector: 'div' });

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByText('議事録', { selector: 'div' })).toBeNull();
  });

  it('2文字以下では3文字以上を推奨するヒントを表示する', async () => {
    stubFetch({ 'GET /api/search': { results: [] } });
    renderSearchBox();

    fireEvent.change(screen.getByPlaceholderText('検索'), { target: { value: 'ab' } });

    expect(await screen.findByText('3文字以上を推奨します')).toBeTruthy();
  });

  it('3文字以上で結果が0件のとき「見つかりませんでした」を表示する', async () => {
    stubFetch({ 'GET /api/search': { results: [] } });
    renderSearchBox();

    fireEvent.change(screen.getByPlaceholderText('検索'), { target: { value: 'abc' } });

    expect(await screen.findByText('見つかりませんでした')).toBeTruthy();
  });
});
