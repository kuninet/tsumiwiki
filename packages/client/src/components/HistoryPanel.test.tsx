import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryPanel } from './HistoryPanel';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface ErrorOverride {
  status: number;
  error: { code: string; message: string };
}

function isErrorOverride(value: unknown): value is ErrorOverride {
  return typeof value === 'object' && value !== null && 'status' in value && 'error' in value;
}

function stubFetch(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const [path] = url.split('?');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });

    const key = `${method} ${path}`;
    const override = overrides[key];
    if (isErrorOverride(override)) {
      return Promise.resolve({
        ok: false,
        status: override.status,
        json: () => Promise.resolve({ error: override.error }),
      });
    }
    if (key in overrides) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(override) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function renderHistoryPanel(onClose = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HistoryPanel path="メモ.md" onClose={onClose} />
    </QueryClientProvider>,
  );
}

describe('HistoryPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('履歴一覧を表示する', async () => {
    stubFetch({
      'GET /api/history': {
        history: [
          { rev: 'abc1234', authorName: '太郎', date: '2026-07-02T00:00:00+09:00', message: '更新' },
          { rev: 'def5678', authorName: '次郎', date: '2026-07-01T00:00:00+09:00', message: '作成' },
        ],
      },
      'GET /api/history/diff': { diff: '' },
    });

    renderHistoryPanel();

    expect(await screen.findByText(/太郎/)).toBeTruthy();
    expect(screen.getByText(/次郎/)).toBeTruthy();
  });

  it('版を選択して内容タブに切り替えるとその版のcontentを取得して表示する', async () => {
    const calls = stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
      'GET /api/history/content': { content: '過去の本文' },
    });

    renderHistoryPanel();
    await screen.findByText(/太郎/);

    fireEvent.click(screen.getByRole('button', { name: '内容' }));

    expect(await screen.findByText('過去の本文')).toBeTruthy();
    expect(calls.some((c) => c.method === 'GET' && c.path === '/api/history/content')).toBe(true);
  });

  it('差分タブで追加・削除行を表示する', async () => {
    stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '@@ -1 +1 @@\n-旧\n+新' },
    });

    renderHistoryPanel();

    // #64 で prefix (+/-) を剥がして本文の見た目に近づけたため、旧・新それぞれ prefix なしで表示
    expect(await screen.findByText('新')).toBeTruthy();
    expect(screen.getByText('旧')).toBeTruthy();
  });

  it('この版に戻すと、ロック取得→復元→ロック解放の順でAPIを呼ぶ', async () => {
    const calls = stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'POST /api/history/restore': { updatedAt: '2026-07-03T00:00:00+09:00' },
    });

    renderHistoryPanel();
    await screen.findByText(/太郎/);

    fireEvent.click(screen.getByRole('button', { name: 'この版に戻す' }));
    fireEvent.click(await screen.findByRole('button', { name: '戻す' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/locks')).toBe(true);
    });

    const relevant = calls
      .filter((c) => c.path === '/api/locks' || c.path === '/api/history/restore')
      .map((c) => `${c.method} ${c.path}`);
    expect(relevant).toEqual(['POST /api/locks', 'POST /api/history/restore', 'DELETE /api/locks']);
  });

  it('ロック取得に失敗した場合は復元を実行しない', async () => {
    const calls = stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
      'POST /api/locks': { status: 409, error: { code: 'DOC_LOCKED', message: '次郎さんが編集中です' } },
    });

    renderHistoryPanel();
    await screen.findByText(/太郎/);

    fireEvent.click(screen.getByRole('button', { name: 'この版に戻す' }));
    fireEvent.click(await screen.findByRole('button', { name: '戻す' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/locks')).toBe(true);
    });
    expect(calls.some((c) => c.path === '/api/history/restore')).toBe(false);
  });
});
