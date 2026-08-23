import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DocResponse, User } from '@tsumiwiki/shared';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { useUIStore } from '../stores/ui';
import { DocView } from './DocView';

// #199 画像の管理メニュー(右クリック/「⋯」ボタン→名前変更・削除・パスをコピー)の統合テスト。
// 単体の右クリック/ボタン発火はembed-view.test.tsx・image-view.test.tsxで検証済みのため、
// ここではDocView側の橋渡し(resolveAttachment→ContextMenu→各ダイアログ→API呼び出し→
// エディタ内ノードへの反映)を確認する

const DOC: DocResponse = {
  path: 'メモ.md',
  frontmatter: {},
  tags: [],
  body: '![[old.png|300]]\n\n![](sub/old.png)\n',
  updatedAt: '2026-08-01T00:00:00+09:00',
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

function renderDocView(doc: DocResponse = DOC) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DocView doc={doc} currentUser={CURRENT_USER} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DocView の画像管理メニュー(#199)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useEditStore.setState({ mode: 'view', dirty: false, lockedPath: null, lastDraftSavedAt: null });
    useToastStore.setState({ toast: null });
    useUIStore.getState().resetEditorChrome();
  });

  it('右クリック→名前を変更で、リネームAPIを呼びエディタ内のembed/image両ノードのファイル名が置き換わる', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/attachments/resolve': { path: 'old.png', name: 'old.png' },
      'POST /api/attachments/rename': {
        path: 'new.png',
        name: 'new.png',
        rewrittenDocs: [{ path: 'メモ.md', updatedAt: '2026-08-23T00:00:00+09:00' }],
      },
    });
    renderDocView();

    // 自動編集モードに入るのを待つ
    await screen.findByRole('button', { name: /保存/ });

    const embedFrame = await waitFor(() => {
      const el = document.querySelector('.obsidian-embed-image .attachment-frame');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.contextMenu(embedFrame, { clientX: 10, clientY: 20 });

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === 'GET' && c.path === '/api/attachments/resolve'),
      ).toBe(true);
    });

    fireEvent.click(await screen.findByRole('menuitem', { name: '名前を変更' }));

    const input = await screen.findByLabelText('新しいファイル名');
    expect((input as HTMLInputElement).value).toBe('old.png');
    fireEvent.change(input, { target: { value: 'new.png' } });
    fireEvent.click(screen.getByRole('button', { name: '変更' }));

    await waitFor(() => {
      const renameCall = calls.find(
        (c) => c.method === 'POST' && c.path === '/api/attachments/rename',
      );
      expect(renameCall).toBeTruthy();
      expect(renameCall!.body).toEqual({ path: 'old.png', newName: 'new.png' });
    });

    // embedノード: `![[old.png|300]]` → target=new.png(サイズ|300は保持)
    await waitFor(() => {
      const img = document.querySelector('.obsidian-embed-image img') as HTMLImageElement | null;
      expect(img).toBeTruthy();
      expect(img!.getAttribute('src')).toBe(
        `/api/embed?target=${encodeURIComponent('new.png')}&from=${encodeURIComponent('メモ.md')}`,
      );
      expect(img!.getAttribute('width')).toBe('300');
    });

    // 標準画像ノード: `![](sub/old.png)` → src=sub/new.png(フォルダ部分は保持)
    await waitFor(() => {
      const img = document.querySelector('.tiptap-image img') as HTMLImageElement | null;
      expect(img).toBeTruthy();
      expect(img!.getAttribute('src')).toBe(`/api/files/sub/new.png`);
    });

    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe(
        '名前を変更しました(1件の文書の参照を更新)',
      );
    });
  });

  it('409衝突は「同名のファイルがあります」と表示する', async () => {
    // renameだけ409にする
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.startsWith('/api/attachments/rename')) {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ error: { code: 'CONFLICT', message: '既に存在します' } }),
        });
      }
      if (url.startsWith('/api/attachments/resolve')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ path: 'old.png', name: 'old.png' }),
        });
      }
      if (url.startsWith('/api/locks') && method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ lock: { userId: 1, displayName: '太郎' } }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ draft: null }) });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderDocView();

    await screen.findByRole('button', { name: /保存/ });
    const embedFrame = await waitFor(() => {
      const el = document.querySelector('.obsidian-embed-image .attachment-frame');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.contextMenu(embedFrame, { clientX: 10, clientY: 20 });
    fireEvent.click(await screen.findByRole('menuitem', { name: '名前を変更' }));
    const input = await screen.findByLabelText('新しいファイル名');
    fireEvent.change(input, { target: { value: 'dup.png' } });
    fireEvent.click(screen.getByRole('button', { name: '変更' }));

    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe('同名のファイルがあります');
    });
  });

  it('削除確認に他文書からの参照数が出て、確定するとDELETE /api/attachmentsを呼ぶ', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/attachments/resolve': { path: 'old.png', name: 'old.png' },
      'GET /api/attachments/references': { docs: ['メモ.md', '他の文書.md'] },
    });
    renderDocView();

    await screen.findByRole('button', { name: /保存/ });
    const embedFrame = await waitFor(() => {
      const el = document.querySelector('.obsidian-embed-image .attachment-frame');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.contextMenu(embedFrame, { clientX: 10, clientY: 20 });
    fireEvent.click(await screen.findByRole('menuitem', { name: '削除' }));

    expect(
      await screen.findByText(/他の1文書からも参照されています/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/attachments')).toBe(true);
    });
    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe('ごみ箱へ移動しました');
    });
  });

  it('パスをコピーでclipboardへ書き込む', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/attachments/resolve': { path: 'old.png', name: 'old.png' },
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderDocView();

    await screen.findByRole('button', { name: /保存/ });
    const embedFrame = await waitFor(() => {
      const el = document.querySelector('.obsidian-embed-image .attachment-frame');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.contextMenu(embedFrame, { clientX: 10, clientY: 20 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'パスをコピー' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('old.png');
    });
    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe('パスをコピーしました');
    });
  });

  it('未解決(404)ならメニューを出さずトーストのみ表示する', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/attachments/resolve')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () =>
            Promise.resolve({ error: { code: 'NOT_FOUND', message: '見つかりません' } }),
        });
      }
      if (url.startsWith('/api/locks') && (init?.method ?? 'GET') === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ lock: { userId: 1, displayName: '太郎' } }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ draft: null }) });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderDocView();

    await screen.findByRole('button', { name: /保存/ });
    const embedFrame = await waitFor(() => {
      const el = document.querySelector('.obsidian-embed-image .attachment-frame');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.contextMenu(embedFrame, { clientX: 10, clientY: 20 });

    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe('画像ファイルが見つかりません');
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
