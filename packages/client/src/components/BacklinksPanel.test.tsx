import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BacklinksResponse, TreeResponse } from '@tsumiwiki/shared';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUserSettingsStore } from '../stores/user-settings';
import { BacklinksPanel, isOfflineOrNetworkError } from './BacklinksPanel';

interface Call {
  method: string;
  path: string;
  url: string;
}

const TREE_DATA: TreeResponse = {
  docs: [
    { path: 'Target.md', title: 'Target', folder: '', updatedAt: '2026-07-01T00:00:00Z' },
    { path: 'Ref1.md', title: 'Ref1', folder: 'ノート', updatedAt: '2026-07-02T00:00:00Z' },
    { path: 'Ref2.md', title: 'Ref2', folder: '', updatedAt: '2026-07-03T00:00:00Z' },
  ],
  folders: ['ノート'],
};

function stubFetch(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const [path] = url.split('?');
    calls.push({ method, path, url });

    const key = `${method} ${path}`;
    if (key in overrides) {
      const resp = overrides[key];
      if (resp instanceof Error) {
        return Promise.reject(resp);
      }
      if (resp && typeof resp === 'object' && 'status' in resp && (resp as { status: number }).status >= 400) {
        const errorResp = resp as { status: number; body?: unknown };
        return Promise.resolve({
          ok: false,
          status: errorResp.status,
          json: () => Promise.resolve(errorResp.body ?? { error: { message: 'エラー' } }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(resp) });
    }
    if (key === 'GET /api/tree') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(TREE_DATA) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function LocationWatcher({ onChange }: { onChange: (loc: string) => void }) {
  const location = useLocation();
  onChange(location.pathname);
  return null;
}

function renderBacklinksPanel(
  path = 'Target.md',
  enabled = true,
  onLocationChange = vi.fn(),
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/doc/Target.md']}>
        <LocationWatcher onChange={onLocationChange} />
        <BacklinksPanel path={path} enabled={enabled} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('BacklinksPanel', () => {
  beforeEach(() => {
    useUserSettingsStore.setState({
      backlinksSort: 'updated-desc',
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('バックリンクが0件の場合、「この文書へのリンクはありません」を表示する', async () => {
    stubFetch({
      'GET /api/docs/backlinks': { backlinks: [], truncated: false } satisfies BacklinksResponse,
    });

    renderBacklinksPanel();

    await waitFor(() => {
      expect(screen.getByTestId('backlinks-empty').textContent).toBe(
        'この文書へのリンクはありません',
      );
    });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('この文書へのリンク (0)');
  });

  it('1件以上の場合に参照元一覧と整形された抜粋を表示し、生の[[ ]]は含まれない', async () => {
    const data: BacklinksResponse = {
      backlinks: [
        {
          sourcePath: 'Ref1.md',
          sourceTitle: '参照元ノート',
          sourceFolder: 'ノート',
          sourceUpdatedAt: '2026-07-02T12:00:00Z',
          links: [
            {
              line: 5,
              context: 'この件は [[Target|対象機能]] を参照すること。',
              anchor: null,
              alias: '対象機能',
            },
          ],
        },
      ],
      truncated: false,
    };
    stubFetch({
      'GET /api/docs/backlinks': data,
    });

    renderBacklinksPanel();

    await waitFor(() => {
      expect(screen.getByTestId('backlinks-list')).toBeTruthy();
    });

    // タイトルとフォルダが表示される
    expect(screen.getByText('参照元ノート')).toBeTruthy();
    expect(screen.getByText('ノート')).toBeTruthy();

    // 抜粋に「対象機能」が表示され、生の「[[」や「]]」は含まれない
    const list = screen.getByTestId('backlinks-list');
    expect(list.textContent).toContain('この件は 対象機能 を参照すること。');
    expect(list.textContent).not.toContain('[[');
    expect(list.textContent).not.toContain(']]');
  });

  it('参照元タイトルをクリックすると該当文書のURLへ遷移する', async () => {
    const data: BacklinksResponse = {
      backlinks: [
        {
          sourcePath: 'Ref1.md',
          sourceTitle: '参照元ノート',
          sourceFolder: '',
          sourceUpdatedAt: '2026-07-02T12:00:00Z',
          links: [
            {
              line: 1,
              context: '[[Target]]',
              anchor: null,
              alias: null,
            },
          ],
        },
      ],
      truncated: false,
    };
    stubFetch({
      'GET /api/docs/backlinks': data,
    });

    const onLocationChange = vi.fn();
    renderBacklinksPanel('Target.md', true, onLocationChange);

    await waitFor(() => {
      expect(screen.getByText('参照元ノート')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('参照元ノート'));

    // docUrl('Ref1.md') は /doc/Ref1.md
    expect(onLocationChange).toHaveBeenLastCalledWith('/doc/Ref1.md');
  });

  it('enabled=false の場合はバックリンクAPIのフェッチを抑止する', async () => {
    const calls = stubFetch();

    // enabled=false でマウント
    renderBacklinksPanel('Target.md', false);

    // バックリンクのAPIリクエストが飛ばないこと
    expect(calls.some((c) => c.path === '/api/docs/backlinks')).toBe(false);
  });

  it('ソート順を「名前順(降順)」に切り替えるとアイテムの順序が入れ替わる', async () => {
    const data: BacklinksResponse = {
      backlinks: [
        {
          sourcePath: 'A.md',
          sourceTitle: 'A文書',
          sourceFolder: '',
          sourceUpdatedAt: '2026-07-03T12:00:00Z', // 新しい
          links: [{ line: 1, context: '[[Target]]', anchor: null, alias: null }],
        },
        {
          sourcePath: 'Z.md',
          sourceTitle: 'Z文書',
          sourceFolder: '',
          sourceUpdatedAt: '2026-07-01T12:00:00Z', // 古い
          links: [{ line: 1, context: '[[Target]]', anchor: null, alias: null }],
        },
      ],
      truncated: false,
    };
    stubFetch({
      'GET /api/docs/backlinks': data,
    });

    renderBacklinksPanel();

    await waitFor(() => {
      expect(screen.getByTestId('backlinks-list')).toBeTruthy();
    });

    // 既定: updated-desc -> A文書 (新しい) が先頭、Z文書 が次
    const itemsBefore = screen.getAllByTestId(/^backlink-item-/);
    expect(itemsBefore[0].textContent).toContain('A文書');
    expect(itemsBefore[1].textContent).toContain('Z文書');

    // ソート順を名前順(降順)に変更
    const select = screen.getByTestId('backlinks-sort-select');
    fireEvent.change(select, { target: { value: 'name-desc' } });

    // 名前順降順: Z文書 が先頭、A文書 が次
    const itemsAfter = screen.getAllByTestId(/^backlink-item-/);
    expect(itemsAfter[0].textContent).toContain('Z文書');
    expect(itemsAfter[1].textContent).toContain('A文書');
  });

  it('truncated: true の場合に上限注記を表示する', async () => {
    const data: BacklinksResponse = {
      backlinks: [
        {
          sourcePath: 'A.md',
          sourceTitle: 'A文書',
          sourceFolder: '',
          sourceUpdatedAt: '2026-07-01T12:00:00Z',
          links: [{ line: 1, context: '[[Target]]', anchor: null, alias: null }],
        },
      ],
      truncated: true,
    };
    stubFetch({
      'GET /api/docs/backlinks': data,
    });

    renderBacklinksPanel();

    await waitFor(() => {
      expect(screen.getByTestId('backlinks-truncated').textContent).toBe(
        '上位200件のみ表示しています',
      );
    });
  });

  it('APIエラー時にエラーメッセージを表示する', async () => {
    stubFetch({
      'GET /api/docs/backlinks': { status: 500, body: { error: { message: 'サーバーエラー' } } },
    });

    renderBacklinksPanel();

    await waitFor(() => {
      expect(screen.getByTestId('backlinks-error').textContent).toBe(
        'バックリンクを取得できませんでした',
      );
    });
  });

  it('Fetchネットワークエラー(TypeError)時に「オフラインまたはサーバー未稼働」を表示する(#267 レビューM3)', async () => {
    stubFetch({
      'GET /api/docs/backlinks': new TypeError('Failed to fetch'),
    });

    renderBacklinksPanel();

    await waitFor(() => {
      expect(screen.getByTestId('backlinks-error').textContent).toBe(
        'オフラインまたはサーバー未稼働のため表示できません',
      );
    });
  });

  it('navigator.onLine が false の場合に「オフラインまたはサーバー未稼働」を表示する(#267 レビューM3)', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    stubFetch({
      'GET /api/docs/backlinks': { status: 500, body: { error: { message: 'サーバーエラー' } } },
    });

    renderBacklinksPanel();

    await waitFor(() => {
      expect(screen.getByTestId('backlinks-error').textContent).toBe(
        'オフラインまたはサーバー未稼働のため表示できません',
      );
    });
  });

  it('isOfflineOrNetworkError が各ネットワークエラー形式(Fetch, Axios, status 0等)を正しく判定する', () => {
    expect(isOfflineOrNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isOfflineOrNetworkError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true);
    expect(isOfflineOrNetworkError({ code: 'ERR_NETWORK' })).toBe(true);
    expect(isOfflineOrNetworkError({ isAxiosError: true, response: undefined })).toBe(true);
    expect(isOfflineOrNetworkError({ status: 0 })).toBe(true);
    expect(isOfflineOrNetworkError(new Error('connect ECONNREFUSED 127.0.0.1:3000'))).toBe(true);
    expect(isOfflineOrNetworkError(new Error('一般的な例外'))).toBe(false);
    expect(isOfflineOrNetworkError({ status: 500 })).toBe(false);
    expect(isOfflineOrNetworkError(null)).toBe(false);
  });
});
