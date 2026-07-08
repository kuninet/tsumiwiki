import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DocResponse, User } from '@tsumiwiki/shared';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { useUIStore } from '../stores/ui';
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
    useUIStore.getState().resetEditorChrome();
  });

  it('閲覧モードでタイトルと更新日時を表示する', async () => {
    stubFetch();
    renderDocView();

    expect(await screen.findByRole('heading', { name: 'メモ' })).toBeTruthy();
    // JST表示: 2026/07/01 と 00:00:00 を別々に表示
    expect(screen.getByText('2026/07/01')).toBeTruthy();
    expect(screen.getByText('00:00:00')).toBeTruthy();
  });

  it('他者がロック中の場合は編集ボタンが無効化され、編集中である旨が表示される', async () => {
    stubFetch();
    renderDocView({ ...DOC, lock: { userId: 2, displayName: '次郎' } });

    expect(await screen.findByText('次郎さんが編集中')).toBeTruthy();
    const editButton = screen.getByRole('button', { name: '編集' }) as HTMLButtonElement;
    expect(editButton.disabled).toBe(true);
  });

  it('文書を開くと自動で編集モードに入り、履歴ボタンが無効化される(#51)', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
    });
    renderDocView();

    // #51: 開いた瞬間に auto-startEditing が走るので、保存ボタンが表示されるまで待つ
    await screen.findByRole('button', { name: /保存/ });
    const historyButton = screen.getByRole('button', { name: '履歴' }) as HTMLButtonElement;
    expect(historyButton.disabled).toBe(true);
  });

  it('自動編集モードで内容を変更して保存すると、baseUpdatedAtを含めてPUT /api/docsを呼び出す(#51)', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
    });
    renderDocView();

    // 自動で編集モードに入る → 保存ボタン(disabled)を確認
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    // タグチップの × ボタンで dirty=true にしてから保存(入力レースを避けるため削除経路を使う)
    fireEvent.click(screen.getByRole('button', { name: 'タグ #設計 を削除' }));

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/docs')).toBe(true);
    });

    const saveCall = calls.find((c) => c.method === 'PUT' && c.path === '/api/docs')!;
    expect(saveCall.body).toMatchObject({
      path: 'メモ.md',
      baseUpdatedAt: '2026-07-01T00:00:00+09:00',
      tags: [],
    });
  });

  it('下書き復元ダイアログで「復元」を選ぶとダイアログが閉じ内容が反映される', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: { content: '下書きの本文', updatedAt: '2026-07-01T09:00:00+09:00' } },
    });
    renderDocView();

    // #51: auto-startEditing で編集モードに入ると下書き取得ダイアログが自動で開く
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

    // #51: auto-startEditing で編集モードに入ると下書き取得ダイアログが自動で開く
    await screen.findByText('未保存の下書きがあります。復元しますか?');

    fireEvent.click(screen.getByRole('button', { name: '破棄' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/drafts')).toBe(true);
    });
  });

  it('タグを2回連続で削除しても pending 状態が積み上がる(#51 Opus C1)', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
    });
    const docWithMultipleTags: DocResponse = { ...DOC, tags: ['A', 'B', 'C'] };
    renderDocView(docWithMultipleTags);

    await screen.findByRole('button', { name: /保存/ });

    // 連続削除: A → C(残り: B のみ)
    fireEvent.click(screen.getByRole('button', { name: 'タグ #A を削除' }));
    await waitFor(() =>
      expect((screen.queryByRole('button', { name: 'タグ #A を削除' }))).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'タグ #C を削除' }));
    await waitFor(() =>
      expect((screen.queryByRole('button', { name: 'タグ #C を削除' }))).toBeNull(),
    );

    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/docs')).toBe(true);
    });
    const saveCall = calls.find((c) => c.method === 'PUT' && c.path === '/api/docs')!;
    expect(saveCall.body).toMatchObject({ tags: ['B'] });
  });

  it('編集中に「破棄」ボタンで編集内容をキャンセルできる(#51 Opus H2)', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
    });
    renderDocView();

    await screen.findByRole('button', { name: /保存/ });
    // dirty にする
    fireEvent.click(screen.getByRole('button', { name: 'タグ #設計 を削除' }));
    // 破棄ボタンが現れるまで待つ(dirty=true 連動)
    const discardBtn = await screen.findByRole('button', { name: '破棄' });
    fireEvent.click(discardBtn);
    // 確認ダイアログの「破棄」を押す
    const confirmBtns = await screen.findAllByRole('button', { name: '破棄' });
    // 最後の一つ(ConfirmDialog 側)を押す
    fireEvent.click(confirmBtns[confirmBtns.length - 1]);

    // cancelEditing でロック解放とドラフト削除の DELETE が飛ぶ
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/locks')).toBe(true);
    });
  });

  it('タグチップ操作で発生した dirty 状態を Ctrl+S で保存できる(#51)', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
    });
    renderDocView();

    // 自動編集モードに入るまで待つ
    await screen.findByRole('button', { name: /保存/ });

    // タグチップ削除で dirty=true にする(入力レースを避ける)
    fireEvent.click(screen.getByRole('button', { name: 'タグ #設計 を削除' }));

    // dirty=true が反映されて保存ボタンが活性化するのを待つ
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/docs')).toBe(true);
    });

    const saveCall = calls.find((c) => c.method === 'PUT' && c.path === '/api/docs')!;
    expect(saveCall.body).toMatchObject({ tags: [] });
  });

  it('閲覧モードでdocの本文が変わるとエディタの表示が追随する', async () => {
    stubFetch();
    // #51: 他者ロック中(閲覧モード)なら auto-startEditing がスキップされる
    const lockedDoc: DocResponse = { ...DOC, lock: { userId: 2, displayName: '次郎' } };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <DocView doc={lockedDoc} currentUser={CURRENT_USER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('本文です')).toBeTruthy());

    const updatedDoc: DocResponse = { ...lockedDoc, body: '更新後の本文' };
    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <DocView doc={updatedDoc} currentUser={CURRENT_USER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('更新後の本文')).toBeTruthy());
  });

  it('自動編集モードに入っただけではツールバーは表示されない(疑似閲覧)', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
    });
    renderDocView();

    // 保存ボタン=編集モードには入っている
    await screen.findByRole('button', { name: /保存/ });
    // だがツールバーはまだ表示しない
    expect(screen.queryByTestId('editor-toolbar')).toBeNull();
  });

  it('エディタ本文をクリックするとツールバーが表示される', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
    });
    renderDocView();

    await screen.findByRole('button', { name: /保存/ });
    expect(screen.queryByTestId('editor-toolbar')).toBeNull();

    // ProseMirror の editable な本文要素をクリックする
    const proseMirror = document.querySelector('.ProseMirror') as HTMLElement | null;
    expect(proseMirror).not.toBeNull();
    fireEvent.click(proseMirror!);

    await waitFor(() => {
      expect(screen.getByTestId('editor-toolbar')).toBeTruthy();
    });
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

    // #51: auto-startEditing で編集モードに入るまで待つ(保存ボタンの出現で判定)
    await screen.findByRole('button', { name: /保存/ });

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
