import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DocResponse, User } from '@tsumiwiki/shared';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetAttachmentGenerations } from '../lib/attachment-events';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { DocView } from './DocView';

// #199 画像の管理メニュー(右クリック/「⋯」ボタン→名前変更・削除・パスをコピー)の統合テスト。
// 単体の右クリック/ボタン発火はembed-view.test.tsx・image-view.test.tsxで検証済みのため、
// ここではDocView側の橋渡し(resolveAttachment→ContextMenu→各ダイアログ→API呼び出し→
// エディタ内ノードへの反映)を確認する

const DOC: DocResponse = {
  path: 'メモ.md',
  frontmatter: {},
  tags: ['設計'],
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

async function openEmbedMenuAndClick(itemName: string) {
  await screen.findByRole('button', { name: /保存/ });
  const embedFrame = await waitFor(() => {
    const el = document.querySelector('.obsidian-embed-image .attachment-frame');
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
  fireEvent.contextMenu(embedFrame, { clientX: 10, clientY: 20 });
  fireEvent.click(await screen.findByRole('menuitem', { name: itemName }));
}

describe('DocView の画像管理メニュー(#199)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useEditStore.setState({ mode: 'view', dirty: false, lockedPath: null, lastDraftSavedAt: null });
    useToastStore.setState({ toast: null });
    // #199軽微4: reloadKeyの世代カウンタはモジュールスコープのため、テスト間の汚染を避ける
    resetAttachmentGenerations();
  });

  it('右クリック→名前を変更で、リネームAPIを呼びreplacementsに厳密一致するノードだけ書き換わる(重大1)', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/attachments/resolve': { path: 'old.png', name: 'old.png' },
      'POST /api/attachments/rename': {
        path: 'new.png',
        name: 'new.png',
        rewrittenDocs: [
          {
            path: 'メモ.md',
            updatedAt: '2026-08-23T00:00:00+09:00',
            // `![](sub/old.png)` は別実体(別フォルダの画像)なのでサーバーは書き換えない。
            // replacementsにも含まれないため、エディタ側もbasenameだけでは書き換えてはいけない
            replacements: [{ from: 'old.png', to: 'new.png' }],
          },
        ],
      },
    });
    renderDocView();

    await openEmbedMenuAndClick('名前を変更');

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

    // embedノード: `![[old.png|300]]` → target=new.png(サイズ|300は保持、replacementsに一致)。
    // 削除/リネーム後のtsumiwiki:attachment-changedイベント(実機確認対応)により
    // キャッシュバスター`&v=`が付くことがあるためtoContainで検証する
    await waitFor(() => {
      const img = document.querySelector('.obsidian-embed-image img') as HTMLImageElement | null;
      expect(img).toBeTruthy();
      expect(img!.getAttribute('src')).toContain(
        `/api/embed?target=${encodeURIComponent('new.png')}&from=${encodeURIComponent('メモ.md')}`,
      );
      expect(img!.getAttribute('width')).toBe('300');
    });

    // 標準画像ノード: `![](sub/old.png)` はreplacementsに含まれないため書き換わらない(重大1の回帰)。
    // basenameが同じ'old.png'のためtsumiwiki:attachment-changedのキャッシュバスターは付き得るが、
    // パス自体(sub/old.png)は変わらないことを見る
    const img = document.querySelector('.tiptap-image img') as HTMLImageElement | null;
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toContain('/api/files/sub/old.png');
    expect(img!.getAttribute('src')).not.toContain('new.png');

    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe(
        '名前を変更しました(1件の文書の参照を更新)',
      );
    });
  });

  it('wikilink([[old.png]])・linkマーク([説明](old.png))もreplacementsに従って書き換わる(中A)', async () => {
    const docWithLinks: DocResponse = {
      ...DOC,
      body: '![[old.png]]\n\n[[old.png]]\n\n[説明](old.png)\n',
    };
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/attachments/resolve': { path: 'old.png', name: 'old.png' },
      'POST /api/attachments/rename': {
        path: 'new.png',
        name: 'new.png',
        rewrittenDocs: [
          {
            path: 'メモ.md',
            updatedAt: '2026-08-23T00:00:00+09:00',
            // 埋め込み・wikilink・linkはいずれも同じtarget文字列'old.png'を参照するため
            // replacementsは1件で3箇所すべてをカバーする
            replacements: [{ from: 'old.png', to: 'new.png' }],
          },
        ],
      },
      'PUT /api/docs': { updatedAt: '2026-08-23T00:10:00+09:00' },
    });
    renderDocView(docWithLinks);

    await openEmbedMenuAndClick('名前を変更');
    const input = await screen.findByLabelText('新しいファイル名');
    fireEvent.change(input, { target: { value: 'new.png' } });
    fireEvent.click(screen.getByRole('button', { name: '変更' }));

    // embed: target=new.png
    await waitFor(() => {
      const img = document.querySelector('.obsidian-embed-image img') as HTMLImageElement | null;
      expect(img?.getAttribute('src')).toContain(encodeURIComponent('new.png'));
    });

    // wikilink: data-target=new.png(NodeView無しのプレーンノードなのでrenderHTMLの属性を見る)
    await waitFor(() => {
      const wikilinkEl = document.querySelector('.wikilink') as HTMLElement | null;
      expect(wikilinkEl?.getAttribute('data-target')).toBe('new.png');
    });

    // linkマーク: href=new.png
    const anchor = screen.getByText('説明').closest('a');
    expect(anchor?.getAttribute('href')).toBe('new.png');

    // 別の編集(タグ削除)でdirty化してから保存し、PUTのbodyにも3箇所ともnew.pngが
    // 反映されている(=getMarkdown()に反映されている)ことを確認する
    fireEvent.click(screen.getByRole('button', { name: 'タグ #設計 を削除' }));
    await waitFor(() => {
      expect((screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => {
      const saveCall = calls.find((c) => c.method === 'PUT' && c.path === '/api/docs');
      expect(saveCall).toBeTruthy();
      expect(saveCall!.body).toMatchObject({
        body: '![[new.png]]\n\n[[new.png]]\n\n[説明](new.png)',
      });
    });
  });

  it('現在文書がrewrittenDocsに含まれないときはエディタ・キャッシュに一切触らない(重大1)', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/attachments/resolve': { path: 'old.png', name: 'old.png' },
      'POST /api/attachments/rename': {
        path: 'new.png',
        name: 'new.png',
        // 現在文書(メモ.md)を含まないレスポンス
        rewrittenDocs: [
          {
            path: '他の文書.md',
            updatedAt: '2026-08-23T00:00:00+09:00',
            replacements: [{ from: 'old.png', to: 'new.png' }],
          },
        ],
      },
    });
    renderDocView();

    await openEmbedMenuAndClick('名前を変更');
    const input = await screen.findByLabelText('新しいファイル名');
    fireEvent.change(input, { target: { value: 'new.png' } });
    fireEvent.click(screen.getByRole('button', { name: '変更' }));

    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe(
        '名前を変更しました(1件の文書の参照を更新)',
      );
    });

    // 現在文書のノード・更新日時表示は変わらない
    const img = document.querySelector('.obsidian-embed-image img') as HTMLImageElement | null;
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toContain(encodeURIComponent('old.png'));
    expect(screen.getByText('2026/08/01')).toBeTruthy();
  });

  it('リネーム後はdirtyにならず、その後の編集で保存するとPUTのbodyに新しいファイル名が反映される(軽微14含む)', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/attachments/resolve': { path: 'old.png', name: 'old.png' },
      'POST /api/attachments/rename': {
        path: 'new.png',
        name: 'new.png',
        rewrittenDocs: [
          {
            path: 'メモ.md',
            updatedAt: '2026-08-23T00:00:00+09:00',
            replacements: [{ from: 'old.png', to: 'new.png' }],
          },
        ],
      },
      'PUT /api/docs': { updatedAt: '2026-08-23T00:10:00+09:00' },
    });
    renderDocView();

    await openEmbedMenuAndClick('名前を変更');
    const input = await screen.findByLabelText('新しいファイル名');
    fireEvent.change(input, { target: { value: 'new.png' } });
    fireEvent.click(screen.getByRole('button', { name: '変更' }));

    await waitFor(() => {
      const img = document.querySelector('.obsidian-embed-image img') as HTMLImageElement | null;
      expect(img?.getAttribute('src')).toContain(encodeURIComponent('new.png'));
    });

    // リネーム直後はdirtyにならない(保存ボタンは無効のまま)
    const saveBtn = screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    // 別の編集(タグ削除)でdirty化してから保存する。ここでcontentRef(保存対象の本文)が
    // リネーム前のまま(syncBodyが効いていない)だと、保存でnew.pngへの参照が失われ
    // サーバー側の書き換えを上書きしてしまう
    fireEvent.click(screen.getByRole('button', { name: 'タグ #設計 を削除' }));
    await waitFor(() => {
      expect((screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => {
      const saveCall = calls.find((c) => c.method === 'PUT' && c.path === '/api/docs');
      expect(saveCall).toBeTruthy();
      expect(saveCall!.body).toMatchObject({ body: '![[new.png|300]]\n\n![](sub/old.png)' });
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

    await openEmbedMenuAndClick('名前を変更');
    const input = await screen.findByLabelText('新しいファイル名');
    fireEvent.change(input, { target: { value: 'dup.png' } });
    fireEvent.click(screen.getByRole('button', { name: '変更' }));

    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe('同名のファイルがあります');
    });
  });

  it('削除確認は先に「参照を確認しています…」を出し、確定ボタンは結果が届くまで無効(中7)', async () => {
    let resolveReferences: ((v: { docs: string[] }) => void) | undefined;
    const referencesPromise = new Promise<{ docs: string[] }>((resolve) => {
      resolveReferences = resolve;
    });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.startsWith('/api/attachments/references')) {
        return referencesPromise.then((data) => ({
          ok: true,
          status: 200,
          json: () => Promise.resolve(data),
        }));
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
      if (url.startsWith('/api/attachments') && method === 'DELETE') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ draft: null }) });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderDocView();

    await openEmbedMenuAndClick('削除');

    expect(await screen.findByText('参照を確認しています…')).toBeTruthy();
    const confirmBtn = screen.getByRole('button', { name: '削除' }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    resolveReferences?.({ docs: ['メモ.md', '他の文書.md'] });

    await screen.findByText(/他の1文書からも参照されています/);
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '削除' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
  });

  it('削除確定でDELETE /api/attachmentsを呼び、成功トーストを表示する', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/attachments/resolve': { path: 'old.png', name: 'old.png' },
      'GET /api/attachments/references': { docs: ['メモ.md'] },
    });
    renderDocView();

    await openEmbedMenuAndClick('削除');
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '削除' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/attachments')).toBe(true);
    });
    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe('ごみ箱へ移動しました');
    });
  });

  it('削除成功時、実機確認の指摘対応としてtsumiwiki:attachment-changedイベントを発火する', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/attachments/resolve': { path: 'old.png', name: 'old.png' },
      'GET /api/attachments/references': { docs: [] },
    });
    const listener = vi.fn();
    window.addEventListener('tsumiwiki:attachment-changed', listener);
    renderDocView();

    await openEmbedMenuAndClick('削除');
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '削除' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    await waitFor(() => {
      expect(listener).toHaveBeenCalledTimes(1);
    });
    const event = listener.mock.calls[0][0] as CustomEvent<{ names: string[] }>;
    expect(event.detail.names).toEqual(['old.png']);
    window.removeEventListener('tsumiwiki:attachment-changed', listener);
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

    await openEmbedMenuAndClick('パスをコピー');

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

  it('#211: PDFの管理メニューには「拡大表示」があり、選択するとライトボックスが開く', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/attachments/resolve': { path: 'report.pdf', name: 'report.pdf' },
    });
    renderDocView({ ...DOC, body: '![[report.pdf]]\n' });

    await screen.findByRole('button', { name: /保存/ });
    const pdfFrame = await waitFor(() => {
      const el = document.querySelector('.obsidian-embed-pdf-wrapper .attachment-frame--persistent');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.contextMenu(pdfFrame, { clientX: 10, clientY: 20 });
    fireEvent.click(await screen.findByRole('menuitem', { name: '拡大表示' }));

    const dialog = await screen.findByRole('dialog');
    const iframe = dialog.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe!.getAttribute('src')).toBe('/api/files/report.pdf');
  });

  it('#211: PDF埋め込みの `#page=N` は拡大表示のiframe srcにも引き継がれる(レビュー重大#5)', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/attachments/resolve': { path: 'report.pdf', name: 'report.pdf' },
    });
    renderDocView({ ...DOC, body: '![[report.pdf#page=3]]\n' });

    await screen.findByRole('button', { name: /保存/ });
    const pdfFrame = await waitFor(() => {
      const el = document.querySelector('.obsidian-embed-pdf-wrapper .attachment-frame--persistent');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.contextMenu(pdfFrame, { clientX: 10, clientY: 20 });
    fireEvent.click(await screen.findByRole('menuitem', { name: '拡大表示' }));

    const dialog = await screen.findByRole('dialog');
    const iframe = dialog.querySelector('iframe');
    expect(iframe!.getAttribute('src')).toBe('/api/files/report.pdf#page=3');
  });

  it('#211: 画像埋め込みをクリックするとライトボックスが開く', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
    });
    renderDocView();

    await screen.findByRole('button', { name: /保存/ });
    const img = await waitFor(() => {
      const el = document.querySelector('.obsidian-embed-image img');
      expect(el).toBeTruthy();
      return el as HTMLImageElement;
    });
    const originalSrc = img.getAttribute('src');
    fireEvent.click(img);

    const dialog = await screen.findByRole('dialog');
    const lightboxImg = dialog.querySelector('img');
    expect(lightboxImg).toBeTruthy();
    expect(lightboxImg!.getAttribute('src')).toBe(originalSrc);
  });
});
