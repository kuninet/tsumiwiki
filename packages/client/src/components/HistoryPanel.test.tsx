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

function renderHistoryPanel(
  onClose = vi.fn(),
  options: { isDirty?: boolean; beforeRestore?: () => Promise<void> } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HistoryPanel
        path="メモ.md"
        onClose={onClose}
        isDirty={options.isDirty}
        beforeRestore={options.beforeRestore}
      />
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

  it('編集中(isDirty=true)は確認ダイアログで未保存変更の破棄を明示する(#106)', async () => {
    stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
    });

    renderHistoryPanel(vi.fn(), { isDirty: true });
    await screen.findByText(/太郎/);

    fireEvent.click(screen.getByRole('button', { name: 'この版に戻す' }));
    // dirty 時はメッセージが差し替わる
    expect(await screen.findByText(/未保存の変更が失われます/)).toBeTruthy();
  });

  it('beforeRestoreが渡されているとき、restoreRevisionより前に呼ばれる(#106)', async () => {
    const events: string[] = [];
    const calls = stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'POST /api/history/restore': { updatedAt: '2026-07-03T00:00:00+09:00' },
    });
    // fetch呼び出しにも順序を刻む(beforeRestoreとrestoreRevisionの前後関係を突き合わせるため)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const [path] = url.split('?');
      if (path === '/api/history/restore') events.push('restore');
      if (path === '/api/locks' && method === 'POST') events.push('acquireLock');
      return originalFetch(url, init);
    }) as typeof fetch;

    const beforeRestore = vi.fn(async () => {
      events.push('beforeRestore');
    });

    renderHistoryPanel(vi.fn(), { isDirty: true, beforeRestore });
    await screen.findByText(/太郎/);

    fireEvent.click(screen.getByRole('button', { name: 'この版に戻す' }));
    fireEvent.click(await screen.findByRole('button', { name: '戻す' }));

    await waitFor(() => {
      expect(calls.some((c) => c.path === '/api/history/restore')).toBe(true);
    });
    // 順序: beforeRestore(編集セッション片付け) → acquireLock → restore
    expect(events).toEqual(['beforeRestore', 'acquireLock', 'restore']);
    expect(beforeRestore).toHaveBeenCalledTimes(1);
  });

  it('編集モードだが未変更(isDirty=false かつ beforeRestore あり)でもbeforeRestoreは呼ばれる(#106)', async () => {
    // #51 の自動編集モードでは「開いた直後は毎回 isDirty=false, beforeRestore=定義済み」の
    // 組み合わせが発生する。この分岐で beforeRestore を短絡させると閲覧モードへ戻さないまま
    // restore が走り、autoEditAttemptedRef が再発火する余地が生まれるため、必ず呼ばれることを固定する
    const calls = stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'POST /api/history/restore': { updatedAt: '2026-07-03T00:00:00+09:00' },
    });
    const beforeRestore = vi.fn(async () => {});

    renderHistoryPanel(vi.fn(), { isDirty: false, beforeRestore });
    await screen.findByText(/太郎/);

    fireEvent.click(screen.getByRole('button', { name: 'この版に戻す' }));
    // dirty=false のときは通常文言のまま(未保存変更の警告は出さない)
    expect(await screen.findByText(/現在の内容を破棄してこの版に戻します/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '戻す' }));

    await waitFor(() => {
      expect(calls.some((c) => c.path === '/api/history/restore')).toBe(true);
    });
    expect(beforeRestore).toHaveBeenCalledTimes(1);
  });

  it('beforeRestoreが例外を投げた場合は復元を実行しない(#106)', async () => {
    const calls = stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
    });
    const beforeRestore = vi.fn(async () => {
      throw new Error('編集の破棄に失敗');
    });

    renderHistoryPanel(vi.fn(), { isDirty: true, beforeRestore });
    await screen.findByText(/太郎/);

    fireEvent.click(screen.getByRole('button', { name: 'この版に戻す' }));
    fireEvent.click(await screen.findByRole('button', { name: '戻す' }));

    await waitFor(() => {
      expect(beforeRestore).toHaveBeenCalled();
    });
    expect(calls.some((c) => c.path === '/api/history/restore')).toBe(false);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/locks')).toBe(false);
  });

  it('初期表示は『この文書』スコープ', async () => {
    stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
    });

    renderHistoryPanel();
    await screen.findByText(/太郎/);

    expect(screen.getByRole('tab', { name: 'この文書' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: '全体' }).getAttribute('aria-selected')).toBe('false');
  });

  it('『全体』に切替でuseAllHistoryのAPIを呼ぶ', async () => {
    const calls = stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
      'GET /api/history/all/diff': { diff: '' },
      'GET /api/history/all': {
        history: [
          {
            rev: 'aaa1111',
            authorName: '太郎',
            date: '2026-07-01T00:00:00+09:00',
            message: '更新',
            paths: ['メモ.md'],
          },
        ],
      },
    });

    renderHistoryPanel();
    await screen.findByText(/太郎/);

    fireEvent.click(screen.getByRole('tab', { name: '全体' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'GET' && c.path === '/api/history/all')).toBe(true);
    });
  });

  it('『全体』時の差分は /api/history/all/diff(rev^..rev)を叩く(#66レビュー指摘対応)', async () => {
    const calls = stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
      'GET /api/history/all/diff': { diff: '' },
      'GET /api/history/all': {
        history: [
          {
            rev: 'aaa1111',
            authorName: '太郎',
            date: '2026-07-01T00:00:00+09:00',
            message: '更新',
            paths: ['メモ.md'],
          },
        ],
      },
    });

    renderHistoryPanel();
    await screen.findByText(/太郎/);
    fireEvent.click(screen.getByRole('tab', { name: '全体' }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === 'GET' && c.path.startsWith('/api/history/all/diff')),
      ).toBe(true);
    });
    // 「この文書」用の /api/history/diff は全体時には叩かれない
    expect(
      calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/history/diff')).length,
    ).toBeLessThanOrEqual(1);
  });

  it('『全体』時のエントリはパスが表示される', async () => {
    stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
      'GET /api/history/all/diff': { diff: '' },
      'GET /api/history/all': {
        history: [
          {
            rev: 'aaa1111',
            authorName: '太郎',
            date: '2026-07-01T00:00:00+09:00',
            message: '複数編集',
            paths: ['議事録.md', '週次.md'],
          },
        ],
      },
    });

    renderHistoryPanel();
    await screen.findByText(/太郎/);

    fireEvent.click(screen.getByRole('tab', { name: '全体' }));

    // titleFromPath 適用でファイル名から拡張子と親フォルダは落ちる(#66レビュー指摘対応)
    expect(await screen.findByText('議事録', { exact: false })).toBeTruthy();
    expect(screen.getByText(/\+他1件/)).toBeTruthy();
  });

  it('『全体』時は「この版に戻す」ボタンが非表示', async () => {
    stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
      'GET /api/history/all/diff': { diff: '' },
      'GET /api/history/all': {
        history: [
          {
            rev: 'aaa1111',
            authorName: '太郎',
            date: '2026-07-01T00:00:00+09:00',
            message: '更新',
            paths: ['メモ.md'],
          },
        ],
      },
    });

    renderHistoryPanel();
    await screen.findByText(/太郎/);
    expect(screen.getByRole('button', { name: 'この版に戻す' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '全体' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'この版に戻す' })).toBeNull();
    });
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
