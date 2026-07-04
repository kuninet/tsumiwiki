import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DocResponse, User } from '@tsumiwiki/shared';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { DocView } from './DocView';

const DOC: DocResponse = {
  path: 'メモ.md',
  frontmatter: {},
  tags: ['設計'],
  body: '本文です',
  updatedAt: '2026-07-01T00:00:00+09:00',
  lock: null,
};

const CURRENT_USER: User = {
  id: 1,
  username: 'taro',
  displayName: '太郎',
  role: 'user',
  disabled: false,
};

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
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, draft: null }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function renderDocView(doc: DocResponse = DOC, currentUser: User = CURRENT_USER) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DocView doc={doc} currentUser={currentUser} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DocView', () => {
  afterEach(() => {
    // cleanup()によるアンマウントでuse-editing-sessionのロック解放(fetch)が走るため、
    // fetchスタブを外す前にアンマウントを済ませる(順序が逆だと実fetchが相対URLで失敗する)
    cleanup();
    vi.unstubAllGlobals();
    useEditStore.setState({ mode: 'view', dirty: false, lockedPath: null, lastDraftSavedAt: null });
    useToastStore.setState({ toast: null });
  });

  it('閲覧モードでタイトルと更新日時を表示する', async () => {
    stubFetch();
    renderDocView();

    expect(await screen.findByRole('heading', { name: 'メモ' })).toBeTruthy();
    expect(screen.getByText(/更新日時: 2026-07-01T00:00:00\+09:00/)).toBeTruthy();
  });

  it('他者がロック中の場合は編集ボタンが無効化され、編集中である旨が表示される', async () => {
    stubFetch();
    renderDocView({ ...DOC, lock: { userId: 2, displayName: '次郎' } });

    expect(await screen.findByText('次郎さんが編集中')).toBeTruthy();
    const editButton = screen.getByRole('button', { name: '編集' }) as HTMLButtonElement;
    expect(editButton.disabled).toBe(true);
  });

  it('編集を開始して保存すると、baseUpdatedAtを含めてPUT /api/docsを呼び出す', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
    });
    renderDocView();

    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    await screen.findByRole('button', { name: '保存' });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/docs')).toBe(true);
    });

    const saveCall = calls.find((c) => c.method === 'PUT' && c.path === '/api/docs')!;
    expect(saveCall.body).toMatchObject({
      path: 'メモ.md',
      baseUpdatedAt: '2026-07-01T00:00:00+09:00',
      tags: ['設計'],
    });
  });

  it('下書き復元ダイアログで「復元」を選ぶとダイアログが閉じ内容が反映される', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: { content: '下書きの本文', updatedAt: '2026-07-01T09:00:00+09:00' } },
    });
    renderDocView();

    fireEvent.click(await screen.findByRole('button', { name: '編集' }));

    expect(await screen.findByText('未保存の下書きがあります。復元しますか?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '復元' }));

    await waitFor(() => {
      expect(screen.queryByText('未保存の下書きがあります。復元しますか?')).toBeNull();
    });
  });

  it('下書き復元ダイアログで「キャンセル」を選ぶと下書きを破棄する', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: { content: '下書きの本文', updatedAt: '2026-07-01T09:00:00+09:00' } },
    });
    renderDocView();

    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    await screen.findByText('未保存の下書きがあります。復元しますか?');

    fireEvent.click(screen.getByRole('button', { name: '破棄' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/drafts')).toBe(true);
    });
  });

  it('タグ入力を変更してCtrl+Sで保存すると、ボタン経由でなくても新しいタグが送られる', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
    });
    renderDocView();

    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    const tagsInput = await screen.findByLabelText('タグ(カンマ区切り)');
    fireEvent.change(tagsInput, { target: { value: '設計, 新タグ' } });

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/docs')).toBe(true);
    });

    const saveCall = calls.find((c) => c.method === 'PUT' && c.path === '/api/docs')!;
    expect(saveCall.body).toMatchObject({ tags: ['設計', '新タグ'] });
  });

  it('閲覧モードでdocの本文が変わるとエディタの表示が追随する', async () => {
    stubFetch();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <DocView doc={DOC} currentUser={CURRENT_USER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('本文です')).toBeTruthy());

    const updatedDoc: DocResponse = { ...DOC, body: '更新後の本文' };
    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <DocView doc={updatedDoc} currentUser={CURRENT_USER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('更新後の本文')).toBeTruthy());
  });

  it('編集モード中はdocの本文が変わってもエディタの表示を上書きしない', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <DocView doc={DOC} currentUser={CURRENT_USER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    await screen.findByRole('button', { name: '保存' });

    const updatedDoc: DocResponse = { ...DOC, body: '外部で更新された本文' };
    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <DocView doc={updatedDoc} currentUser={CURRENT_USER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByText('外部で更新された本文')).toBeNull();
    });
    expect(screen.getByText('本文です')).toBeTruthy();
  });
});

describe('#32レビュー指摘の回帰テスト', () => {
  it('リンクURLのスキーム検証(javascript:等の実行系を拒否)', async () => {
    const { isAllowedLinkUrl } = await import('../lib/allowed-link');
    for (const u of ['https://example.com', 'http://a', 'mailto:a@b', 'file:///C:/x', 'notes/x']) {
      expect(isAllowedLinkUrl(u)).toBe(true);
    }
    for (const u of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'JAVASCRIPT:alert(1)']) {
      expect(isAllowedLinkUrl(u)).toBe(false);
    }
  });
});
