import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryPage } from './HistoryPage';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function stubFetch(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const [path] = url.split('?');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });

    const key = `${method} ${path}`;
    if (key in overrides) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(overrides[key]) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function DocProbe() {
  return <div data-testid="doc-probe">文書ページ</div>;
}

function renderHistoryPage(initialPath = `/history/${encodeURIComponent('メモ.md')}`) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/history/*" element={<HistoryPage />} />
          <Route path="/doc/*" element={<DocProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('HistoryPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('パス未指定のときはメッセージを表示する', async () => {
    stubFetch();
    renderHistoryPage('/history');

    expect(await screen.findByText('文書が指定されていません')).toBeTruthy();
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

    renderHistoryPage();

    expect(await screen.findByText(/太郎/)).toBeTruthy();
    expect(screen.getByText(/次郎/)).toBeTruthy();
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

    renderHistoryPage();
    await screen.findByText(/太郎/);

    fireEvent.click(screen.getByRole('tab', { name: '全体' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'GET' && c.path === '/api/history/all')).toBe(true);
    });
  });

  it('『全体』時は[この版に戻す]が非表示', async () => {
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

    renderHistoryPage();
    await screen.findByText(/太郎/);
    expect(screen.getByRole('button', { name: 'この版に戻す' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '全体' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'この版に戻す' })).toBeNull();
    });
  });

  it('[← 文書に戻る]リンクは/doc/<path>を指す', async () => {
    stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
    });

    renderHistoryPage();
    await screen.findByText(/太郎/);

    const link = screen.getByRole('link', { name: /文書に戻る/ });
    expect(link.getAttribute('href')).toBe(`/doc/${encodeURIComponent('メモ.md')}`);
  });

  it('Escapeキーで文書ページに遷移する', async () => {
    stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
    });

    renderHistoryPage();
    await screen.findByText(/太郎/);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(await screen.findByTestId('doc-probe')).toBeTruthy();
  });

  it('復元確認ダイアログ表示中のEscapeでは遷移しない(#66レビュー指摘対応)', async () => {
    stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
    });

    renderHistoryPage();
    await screen.findByText(/太郎/);

    // 復元確認ダイアログを開く
    fireEvent.click(screen.getByRole('button', { name: 'この版に戻す' }));
    await screen.findByRole('button', { name: '戻す' });

    fireEvent.keyDown(window, { key: 'Escape' });

    // ダイアログ表示中はページ遷移が発火しない
    expect(screen.queryByTestId('doc-probe')).toBeNull();
    // ダイアログ自体は開いたまま(ConfirmDialog に独立した Escape ハンドラが無いため)
    expect(screen.getByRole('button', { name: '戻す' })).toBeTruthy();
  });

  it('入力欄フォーカス中のEscapeでは遷移しない(#66レビュー指摘対応)', async () => {
    stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
    });

    renderHistoryPage();
    await screen.findByText(/太郎/);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    fireEvent.keyDown(window, { key: 'Escape' });

    // input にフォーカスがあると history ページの Escape は無視される
    expect(screen.queryByTestId('doc-probe')).toBeNull();
    document.body.removeChild(input);
  });

  it('パスに特殊文字(#・?・%)を含んでも[← 文書に戻る]の href は正しくエンコードされる(#66レビュー指摘対応)', async () => {
    stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
    });

    const specialPath = 'フォルダ/foo?bar#baz.md';
    // react-router の splat は %エスケープを decode する。ラウンドトリップを検証
    const encoded = specialPath.split('/').map(encodeURIComponent).join('/');
    renderHistoryPage(`/history/${encoded}`);
    await screen.findByText(/太郎/);

    const link = screen.getByRole('link', { name: /文書に戻る/ });
    expect(link.getAttribute('href')).toBe(`/doc/${encoded}`);
  });

  it('全体スコープ時は「表示中: <path>」が表示される(#66レビュー指摘対応)', async () => {
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
            paths: ['議事録/週次.md', 'メモ.md'],
          },
        ],
      },
    });

    renderHistoryPage();
    await screen.findByText(/太郎/);

    fireEvent.click(screen.getByRole('tab', { name: '全体' }));

    // 選択エントリの代表パス(paths[0])が「表示中:」の後に出る
    expect(await screen.findByText(/表示中:/)).toBeTruthy();
    expect(screen.getByText(/議事録\/週次\.md/)).toBeTruthy();
  });

  it('初期表示ではレイアウト「1列」タブが選択されている(#66 Phase 1c)', async () => {
    stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '' },
    });

    renderHistoryPage();
    await screen.findByText(/太郎/);

    expect(screen.getByRole('tab', { name: '1列' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: '2列' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.queryByTestId('side-by-side-diff-view')).toBeNull();
  });

  it('「2列」タブをクリックするとSideBySideDiffViewが使われる(#66 Phase 1c)', async () => {
    stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '@@ -1 +1 @@\n-旧\n+新\n' },
    });

    renderHistoryPage();
    await screen.findByText(/太郎/);

    fireEvent.click(screen.getByRole('tab', { name: '2列' }));

    expect(await screen.findByTestId('side-by-side-diff-view')).toBeTruthy();
  });

  it('スコープを「全体」に切り替えてもレイアウト設定は維持される(#66 Phase 1c)', async () => {
    stubFetch({
      'GET /api/history': {
        history: [{ rev: 'abc1234', authorName: '太郎', date: '2026-07-01T00:00:00+09:00', message: '更新' }],
      },
      'GET /api/history/diff': { diff: '@@ -1 +1 @@\n-旧\n+新\n' },
      'GET /api/history/all/diff': { diff: '@@ -1 +1 @@\n-旧\n+新\n' },
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

    renderHistoryPage();
    await screen.findByText(/太郎/);

    fireEvent.click(screen.getByRole('tab', { name: '2列' }));
    await screen.findByTestId('side-by-side-diff-view');

    fireEvent.click(screen.getByRole('tab', { name: '全体' }));

    expect(await screen.findByTestId('side-by-side-diff-view')).toBeTruthy();
    expect(screen.getByRole('tab', { name: '2列' }).getAttribute('aria-selected')).toBe('true');
  });

  it('rev選択を切り替えてもレイアウト設定は維持される(#66 Phase 1c レビュー指摘対応)', async () => {
    stubFetch({
      'GET /api/history': {
        history: [
          { rev: 'abc1234', authorName: '太郎', date: '2026-07-02T00:00:00+09:00', message: '更新2' },
          { rev: 'def5678', authorName: '次郎', date: '2026-07-01T00:00:00+09:00', message: '更新1' },
        ],
      },
      'GET /api/history/diff': { diff: '@@ -1 +1 @@\n-旧\n+新\n' },
    });

    renderHistoryPage();
    await screen.findByText(/太郎/);

    // 2列に切り替え
    fireEvent.click(screen.getByRole('tab', { name: '2列' }));
    await screen.findByTestId('side-by-side-diff-view');

    // 別revをクリックして選択を切り替える
    fireEvent.click(screen.getByText(/次郎/));

    // rev切替後もlayoutは2列のまま
    expect(await screen.findByTestId('side-by-side-diff-view')).toBeTruthy();
    expect(screen.getByRole('tab', { name: '2列' }).getAttribute('aria-selected')).toBe('true');
  });
});
