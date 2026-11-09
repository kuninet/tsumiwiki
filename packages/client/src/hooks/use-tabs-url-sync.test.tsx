import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getActivePaneActiveIdFromState,
  getActivePaneTabsFromState,
  useTabsStore,
} from '../stores/tabs';
import { useTabsUrlSync } from './use-tabs-url-sync';

function Probe() {
  useTabsUrlSync();
  const location = useLocation();
  return <div data-testid="current-pathname">{location.pathname}</div>;
}

function renderWith(initialPath: string, qc?: QueryClient) {
  const client =
    qc ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/" element={<Probe />} />
          <Route path="doc/*" element={<Probe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function stubFetchTree(treeDocs: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            folders: [],
            docs: treeDocs.map((p) => ({
              path: p,
              title: p,
              folder: '',
              updatedAt: '2026-01-01T00:00:00Z',
            })),
          }),
      }),
    ),
  );
}

describe('useTabsUrlSync', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('/doc/foo.md で開くと foo.md タブが preview として作成されアクティブになる', async () => {
    stubFetchTree(['foo.md']);
    renderWith('/doc/foo.md');
    await Promise.resolve();
    expect(getActivePaneTabsFromState(useTabsStore.getState()).map((t) => t.path)).toEqual([
      'foo.md',
    ]);
    expect(getActivePaneActiveIdFromState(useTabsStore.getState())).toBe('foo.md');
  });

  it('URL 変化で既存タブがある場合はアクティブ切替のみで新規は作らない', async () => {
    stubFetchTree(['a.md', 'b.md']);
    useTabsStore.getState().openDoc('a.md', { pinned: true });
    useTabsStore.getState().openDoc('b.md', { pinned: true });
    expect(getActivePaneTabsFromState(useTabsStore.getState())).toHaveLength(2);

    renderWith('/doc/a.md');
    await Promise.resolve();
    expect(getActivePaneTabsFromState(useTabsStore.getState())).toHaveLength(2);
    expect(getActivePaneActiveIdFromState(useTabsStore.getState())).toBe('a.md');
  });

  // Case 1: .md なし URL の自動補完
  it('Case 1: .md なし URL でアクセスすると、正規パスに URL 置換されタブが開く', async () => {
    stubFetchTree(['docs/guide.md']);
    renderWith('/doc/docs/guide');

    await waitFor(() => {
      expect(screen.getByTestId('current-pathname').textContent).toBe('/doc/docs/guide.md');
      expect(getActivePaneActiveIdFromState(useTabsStore.getState())).toBe('docs/guide.md');
    });
  });

  // Case 2: ツリー未取得時の待機
  it('Case 2: ツリー未取得時は待機し、取得完了時に補完されてタブが開く', async () => {
    let resolveTreePromise!: (val: unknown) => void;
    const pendingTreePromise = new Promise((resolve) => {
      resolveTreePromise = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(() => pendingTreePromise),
    );

    renderWith('/doc/docs/guide');

    // ツリー取得前はタブが開かれない
    await Promise.resolve();
    expect(getActivePaneTabsFromState(useTabsStore.getState())).toHaveLength(0);
    expect(screen.getByTestId('current-pathname').textContent).toBe('/doc/docs/guide');

    // ツリー取得完了
    resolveTreePromise({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          folders: [],
          docs: [
            {
              path: 'docs/guide.md',
              title: 'Guide',
              folder: 'docs',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
    });

    await waitFor(() => {
      expect(screen.getByTestId('current-pathname').textContent).toBe('/doc/docs/guide.md');
      expect(getActivePaneActiveIdFromState(useTabsStore.getState())).toBe('docs/guide.md');
    });
  });

  // Case 3: 存在しないパス
  it('Case 3: ツリーに存在しないパスの場合は URL は置換されず、元のパスで openDoc される', async () => {
    stubFetchTree(['docs/guide.md']);
    renderWith('/doc/unknown');

    await waitFor(() => {
      expect(getActivePaneActiveIdFromState(useTabsStore.getState())).toBe('unknown');
    });
    expect(screen.getByTestId('current-pathname').textContent).toBe('/doc/unknown');
  });

  // Case 4: ドットを含むファイル名
  it('Case 4: ドットを含むファイル名 (v1.2) も正しく .md に補完・URL置換される', async () => {
    stubFetchTree(['release/v1.2.md']);
    renderWith('/doc/release/v1.2');

    await waitFor(() => {
      expect(screen.getByTestId('current-pathname').textContent).toBe('/doc/release/v1.2.md');
      expect(getActivePaneActiveIdFromState(useTabsStore.getState())).toBe('release/v1.2.md');
    });
  });

  // Case 5: 最初から .md が付いている場合
  it('Case 5: 最初から .md が付いている場合はツリーを待たずに即座に開く', async () => {
    // 解決されない fetch (ツリー未解決)
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );

    renderWith('/doc/docs/guide.md');

    // ツリー解決前でも即時タブが開く
    expect(getActivePaneActiveIdFromState(useTabsStore.getState())).toBe('docs/guide.md');
    expect(screen.getByTestId('current-pathname').textContent).toBe('/doc/docs/guide.md');
  });

  // 追加: 大文字小文字フォールバック
  it('大文字小文字フォールバックでツリーの実在パスに正規化される', async () => {
    stubFetchTree(['docs/Guide.md']);
    renderWith('/doc/docs/guide');

    await waitFor(() => {
      expect(screen.getByTestId('current-pathname').textContent).toBe('/doc/docs/Guide.md');
      expect(getActivePaneActiveIdFromState(useTabsStore.getState())).toBe('docs/Guide.md');
    });
  });

  // M1: .MD など大文字拡張子の URL の正規化
  it('大文字拡張子 (.MD) の URL はツリーの実在パス (.md) に正規化・置換される', async () => {
    stubFetchTree(['docs/guide.md']);
    renderWith('/doc/docs/guide.MD');

    await waitFor(() => {
      expect(screen.getByTestId('current-pathname').textContent).toBe('/doc/docs/guide.md');
      expect(getActivePaneActiveIdFromState(useTabsStore.getState())).toBe('docs/guide.md');
    });
  });

  // M2: ツリー取得エラー時のフォールバック
  it('ツリー取得エラー時は URL のパスのまま openDoc される', async () => {
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

    renderWith('/doc/docs/guide');

    await waitFor(() => {
      expect(getActivePaneActiveIdFromState(useTabsStore.getState())).toBe('docs/guide');
    });
    expect(screen.getByTestId('current-pathname').textContent).toBe('/doc/docs/guide');
  });

  // 重複防止: 既に pinned で開いている状態で .md なし URL にアクセスしてもタブが重複しない
  it('既に docs/guide.md が開いている状態で /doc/docs/guide にアクセスしてもタブは重複しない', async () => {
    stubFetchTree(['docs/guide.md']);
    useTabsStore.getState().openDoc('docs/guide.md', { pinned: true });
    expect(getActivePaneTabsFromState(useTabsStore.getState())).toHaveLength(1);

    renderWith('/doc/docs/guide');

    await waitFor(() => {
      expect(screen.getByTestId('current-pathname').textContent).toBe('/doc/docs/guide.md');
      expect(getActivePaneTabsFromState(useTabsStore.getState())).toHaveLength(1);
      expect(getActivePaneActiveIdFromState(useTabsStore.getState())).toBe('docs/guide.md');
    });
  });

  // m4: キャッシュ済みツリーでの初回マウント時も即時に URL 置換される
  it('ツリーがキャッシュ済みの場合は初回レンダー時に即時 URL 置換される', async () => {
    stubFetchTree(['docs/guide.md']);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(['tree'], {
      folders: [],
      docs: [
        {
          path: 'docs/guide.md',
          title: 'Guide',
          folder: 'docs',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    renderWith('/doc/docs/guide', qc);

    await waitFor(() => {
      expect(screen.getByTestId('current-pathname').textContent).toBe('/doc/docs/guide.md');
      expect(getActivePaneActiveIdFromState(useTabsStore.getState())).toBe('docs/guide.md');
    });
  });
});
