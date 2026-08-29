import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DocResponse, User } from '@tsumiwiki/shared';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { useUIStore } from '../stores/ui';
import { DocView } from './DocView';

// #224 ソース編集モードの統合テスト。ソーストグル→textareaが表示され、
// 入力がupdateBody経由でdirtyになる→WYSIWYGへ戻すと反映される、という結線を確認する。
// 単体のトグルボタン挙動はEditorToolbar.test.tsxで検証済みのため、
// ここではDocView側の状態管理(sourceMode)との橋渡しのみを見る

const DOC: DocResponse = {
  path: 'メモ.md',
  frontmatter: {},
  tags: [],
  body: '本文です',
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

function stubFetch(overrides: Record<string, unknown> = {}) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const [path] = url.split('?');
    const key = `${method} ${path}`;
    if (key in overrides) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(overrides[key]),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, draft: null }),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
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

// 編集モードに入った後、エディタ本文クリックでツールバーを表示させる(#175: 自動表示ではなく
// 実操作起因の表示に限定しているため)
async function revealToolbar() {
  await screen.findByRole('button', { name: /保存/ });
  const proseMirror = document.querySelector('.ProseMirror') as HTMLElement | null;
  expect(proseMirror).not.toBeNull();
  fireEvent.click(proseMirror!);
  await waitFor(() => {
    expect(screen.getByTestId('editor-toolbar')).toBeTruthy();
  });
}

describe('DocView のソース編集モード(#224)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useEditStore.setState({ mode: 'view', dirty: false, lockedPath: null, lastDraftSavedAt: null });
    useToastStore.setState({ toast: null });
    useUIStore.getState().resetEditorChrome();
  });

  it('ソーストグル→textareaが表示され、入力がdirty化→WYSIWYGへ戻すと反映される', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
    });
    renderDocView();
    await revealToolbar();

    // 初期状態ではtextareaは無い
    expect(screen.queryByTestId('source-editor')).toBeNull();
    // 保存はdirtyがまだ無いので無効
    expect((screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement).disabled).toBe(true);

    // ソースへ切り替え
    fireEvent.click(screen.getByRole('button', { name: 'Markdownソースを編集' }));

    const textarea = (await screen.findByTestId('source-editor')) as HTMLTextAreaElement;
    expect(textarea.value).toContain('本文です');
    // WYSIWYG本体は隠れる(unmountはしない)
    expect(document.querySelector('.ProseMirror')?.closest('[hidden]')).not.toBeNull();

    // textarea入力でdirty化(updateBody経由)
    fireEvent.change(textarea, { target: { value: '書き換えた本文' } });
    await waitFor(() => {
      expect((screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    // WYSIWYGへ戻す
    fireEvent.click(screen.getByRole('button', { name: 'WYSIWYG表示に戻す' }));

    expect(screen.queryByTestId('source-editor')).toBeNull();
    await waitFor(() => {
      expect(screen.getByText('書き換えた本文')).toBeTruthy();
    });
  });

  it('無変更のままソース往復してもdirtyにならない(レビュー中2)', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
    });
    renderDocView();
    await revealToolbar();

    fireEvent.click(screen.getByRole('button', { name: 'Markdownソースを編集' }));
    await screen.findByTestId('source-editor');
    // 何も編集せずWYSIWYGへ戻す
    fireEvent.click(screen.getByRole('button', { name: 'WYSIWYG表示に戻す' }));
    expect(screen.queryByTestId('source-editor')).toBeNull();
    // 表示切替だけでは保存ボタンが活性化しない
    expect((screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('閲覧モードに戻ると(破棄)ソースモードも解除される', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
    });
    renderDocView();
    await revealToolbar();

    fireEvent.click(screen.getByRole('button', { name: 'Markdownソースを編集' }));
    await screen.findByTestId('source-editor');
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: '未保存の変更' } });

    // 破棄ボタンが現れるまで待ち、確認ダイアログの「破棄」で編集をキャンセルする
    const discardBtn = await screen.findByRole('button', { name: '破棄' });
    fireEvent.click(discardBtn);
    const confirmBtns = await screen.findAllByRole('button', { name: '破棄' });
    fireEvent.click(confirmBtns[confirmBtns.length - 1]);

    await waitFor(() => {
      expect(screen.queryByTestId('source-editor')).toBeNull();
    });
  });
});
