import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DocResponse, User } from '@tsumiwiki/shared';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEditStore } from '../stores/edit';
import { DocView } from './DocView';

const CURRENT_USER: User = {
  id: 1,
  username: 'taro',
  displayName: '太郎',
  role: 'user',
  disabled: false,
};

function stubFetch(overrides: Record<string, unknown> = {}) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const [path] = url.split('?');
    const key = `${method} ${path}`;
    if (key === 'GET /api/tags') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ tags: [] }) });
    }
    if (key in overrides) {
      const resp = overrides[key];
      const val = typeof resp === 'function' ? resp(url, init) : resp;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(val) });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, draft: null, lock: { userId: 1, displayName: '太郎' } }),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-pathname">{location.pathname}</div>;
}

function renderDocView(doc: DocResponse) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/doc/${encodeURIComponent(doc.path)}`]}>
        <Routes>
          <Route
            path="/doc/*"
            element={
              <>
                <DocView doc={doc} currentUser={CURRENT_USER} />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DocView と PropertiesPanel の結合テスト(D1〜D7)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useEditStore.setState({ mode: 'view', dirty: false, lockedPath: null, lastDraftSavedAt: null, saveError: false });
  });

  it('D1: 配置 - doc-content-wrap 内かつ .ProseMirror より前、hidden 祖先の外に配置される', async () => {
    stubFetch();
    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { category: 'wiki' },
      tags: [],
      body: '本文です',
      updatedAt: '2026-07-01T00:00:00+09:00',
      lock: null,
    };
    renderDocView(doc);

    const panel = await screen.findByTestId('properties-panel');
    const wrap = screen.getByTestId('doc-content-wrap');
    expect(wrap.contains(panel)).toBe(true);

    const prosemirror = wrap.querySelector('.ProseMirror');
    expect(prosemirror).toBeTruthy();
    // panel が prosemirror より前にあること (DOCUMENT_POSITION_FOLLOWING = 4)
    expect(panel.compareDocumentPosition(prosemirror!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // hidden な祖先を持たないこと
    expect(panel.closest('[hidden]')).toBeNull();
  });

  it('D2: 空フロントマター - パネルは描画されず、本文エディタ（.ProseMirror）は通常通り表示される', async () => {
    stubFetch();
    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: {},
      tags: [],
      body: '本文のみ',
      updatedAt: '2026-07-01T00:00:00+09:00',
      lock: null,
    };
    renderDocView(doc);

    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).toBeTruthy();
    });
    expect(screen.queryByTestId('properties-panel')).toBeNull();
  });

  it('D3: ソース編集モード - ソース切替後もパネルが表示され続け、textarea には body のみが入る', async () => {
    stubFetch();
    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { category: 'wiki' },
      tags: [],
      body: '本文Markdownです',
      updatedAt: '2026-07-01T00:00:00+09:00',
      lock: null,
    };
    renderDocView(doc);

    // 編集モードへの遷移（保存ボタンの出現）を待つ
    await screen.findByRole('button', { name: /保存/ });

    // エディタをクリックしてツールバーを表示
    const proseMirror = document.querySelector('.ProseMirror') as HTMLElement | null;
    expect(proseMirror).not.toBeNull();
    fireEvent.click(proseMirror!);

    // 編集ツールバーの「ソース」ボタンをクリック
    const sourceBtn = await screen.findByRole('button', { name: /ソース/ });
    fireEvent.click(sourceBtn);

    // ソース編集textareaが表示される
    const textarea = (await screen.findByTestId('source-editor')) as HTMLTextAreaElement;
    expect(textarea.value).toBe('本文Markdownです');
    expect(textarea.value).not.toContain('category: wiki');

    // パネルは引き続き表示されている
    const panel = screen.getByTestId('properties-panel');
    expect(panel).toBeTruthy();
    expect(panel.closest('[hidden]')).toBeNull();
  });

  it('D4: モード切替で開閉維持 - 編集→破棄（閲覧モード）→再編集してもプロパティパネルの展開状態が保たれる', async () => {
    stubFetch();
    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { category: 'wiki' },
      tags: ['既存タグ'],
      body: '本文',
      updatedAt: '2026-07-01T00:00:00+09:00',
      lock: null,
    };
    renderDocView(doc);

    // パネルを展開
    const toggleBtn = await screen.findByRole('button', { name: /プロパティ/ });
    fireEvent.click(toggleBtn);
    expect(screen.getByText('category')).toBeTruthy();
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');

    // タグ削除で dirty にする
    fireEvent.click(screen.getByRole('button', { name: 'タグ #既存タグ を削除' }));
    // 破棄ボタンをクリック
    const discardBtn = await screen.findByRole('button', { name: '破棄' });
    fireEvent.click(discardBtn);
    // 確認ダイアログの破棄ボタンをクリック
    const confirmBtns = await screen.findAllByRole('button', { name: '破棄' });
    fireEvent.click(confirmBtns[confirmBtns.length - 1]);

    // 閲覧モードに戻る（「✎ 編集」ボタンが表示される）
    const editBtn = await screen.findByRole('button', { name: /編集/ });
    expect(editBtn.textContent).toContain('編集');

    // 閲覧モードでも展開状態が保たれている
    expect(screen.getByText('category')).toBeTruthy();
    expect(screen.getByRole('button', { name: /プロパティ/ }).getAttribute('aria-expanded')).toBe('true');

    // 再度編集ボタンをクリックして編集モードに入る
    fireEvent.click(editBtn);
    await screen.findByRole('button', { name: /保存/ });

    // 編集モードでも引き続き展開状態が保たれている
    expect(screen.getByText('category')).toBeTruthy();
    expect(screen.getByRole('button', { name: /プロパティ/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('D5: 編集モードで URL リンクをクリックしても stopPropagation により SPA 離脱しない', async () => {
    stubFetch();
    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { website: 'https://example.com' },
      tags: [],
      body: '本文',
      updatedAt: '2026-07-01T00:00:00+09:00',
      lock: null,
    };
    renderDocView(doc);

    // 編集モードへの移行（保存ボタンの出現）を待つ
    await screen.findByRole('button', { name: /保存/ });

    const toggleBtn = await screen.findByRole('button', { name: /プロパティ/ });
    fireEvent.click(toggleBtn);

    const link = screen.getByRole('link', { name: 'https://example.com' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');

    const locationBefore = screen.getByTestId('location-pathname').textContent;

    // クリックイベントを発火
    fireEvent.click(link);

    // SPA 離脱（URLパスの変化）がないこと
    expect(screen.getByTestId('location-pathname').textContent).toBe(locationBefore);
  });

  it('D6: 閲覧モードで URL リンクをクリックしてもコンテナの window.open と二重発火しない', async () => {
    // 他者ロック中のため閲覧モードで初期化
    stubFetch();
    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { website: 'https://example.com' },
      tags: [],
      body: '本文',
      updatedAt: '2026-07-01T00:00:00+09:00',
      lock: { userId: 999, displayName: '別ユーザー' },
    };
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    renderDocView(doc);

    // 閲覧モードであることを確認
    await screen.findByText('別ユーザーさんが編集中');

    const toggleBtn = screen.getByRole('button', { name: /プロパティ/ });
    fireEvent.click(toggleBtn);

    const link = screen.getByRole('link', { name: 'https://example.com' });
    fireEvent.click(link);

    // PropertyValue の <a> は onClick で stopPropagation しているため、
    // DocView の handleContainerClick での window.open は呼ばれない
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('D7: パネルの折りたたみ操作でエディタの dirty 状態が変化しない', async () => {
    stubFetch();
    const doc: DocResponse = {
      path: 'テスト.md',
      frontmatter: { category: 'wiki' },
      tags: [],
      body: '本文',
      updatedAt: '2026-07-01T00:00:00+09:00',
      lock: null,
    };
    renderDocView(doc);

    const saveBtn = await screen.findByRole('button', { name: /保存/ });
    expect(saveBtn.hasAttribute('disabled')).toBe(true);

    // パネルを展開
    const toggleBtn = screen.getByRole('button', { name: /プロパティ/ });
    fireEvent.click(toggleBtn);
    expect(saveBtn.hasAttribute('disabled')).toBe(true);

    // パネルを再折りたたみ
    fireEvent.click(toggleBtn);
    expect(saveBtn.hasAttribute('disabled')).toBe(true);
  });
});
