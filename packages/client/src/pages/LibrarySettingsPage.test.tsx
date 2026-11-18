import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LIBRARY_SETTINGS_DEFAULTS } from '@tsumiwiki/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibrarySettingsPage } from './LibrarySettingsPage';

// #99: settings.yaml が壊れているとき、admin に対して警告バナーを出し、
//      手動修復後にキャッシュを更新する導線(再読込ボタン)を提供する。
//      サーバーが GET /api/library/settings で返す corrupted フラグに基づく。

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

const SAMPLE_PREVIEW = {
  mode: 'doc-subfolder',
  targetFolder: 'attachments',
  commonFolder: 'attachments',
  moves: [
    {
      fromPath: 'old/pic.png',
      toPath: '企画/attachments/pic-2.png',
      renamed: true,
      referencedBy: ['企画/メモ.md'],
    },
  ],
  rewrites: [
    {
      docPath: '企画/メモ.md',
      lockedBy: null,
      replacements: [{ from: 'pic.png', to: 'pic-2.png' }],
    },
  ],
  skipped: [
    {
      path: 'shared.png',
      reason: 'shared-across-folders',
      referencedBy: ['企画/メモ.md', '議事/メモ.md'],
    },
    {
      path: '_templates/logo.png',
      reason: 'template-folder',
      referencedBy: ['_templates/日誌.md'],
    },
  ],
  lockedWarnings: [] as { docPath: string; displayName: string }[],
  summary: {
    totalAttachments: 3,
    moveCount: 1,
    renameCount: 1,
    rewriteDocCount: 1,
    skipAlreadyInPlace: 0,
    skipShared: 1,
    skipUnreferenced: 0,
    skipTemplate: 1,
  },
};

function stubFetch(
  corrupted: boolean,
  settings = LIBRARY_SETTINGS_DEFAULTS,
  options?: {
    previewResponse?: typeof SAMPLE_PREVIEW;
  },
) {
  const calls: Call[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const [path] = url.split('?');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path, body });

    if (path === '/api/auth/me') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            user: {
              id: 1,
              username: 'admin',
              displayName: '管理者',
              role: 'admin',
              disabled: false,
            },
          }),
      });
    }
    if (path === '/api/library/settings' && method === 'GET') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ settings, corrupted }),
      });
    }
    if (path === '/api/library/settings' && method === 'PUT') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ settings: body }),
      });
    }
    if (path === '/api/attachments/reorganize/preview' && method === 'POST') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(options?.previewResponse ?? SAMPLE_PREVIEW),
      });
    }
    if (path === '/api/attachments/reorganize' && method === 'POST') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            moved: (options?.previewResponse ?? SAMPLE_PREVIEW).moves,
            rewrittenDocs: [
              {
                path: '企画/メモ.md',
                updatedAt: '2026-11-18T12:00:00Z',
                replacements: [{ from: 'pic.png', to: 'pic-2.png' }],
              },
            ],
            skippedCount: 2,
          }),
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LibrarySettingsPage />
    </QueryClientProvider>,
  );
}

describe('LibrarySettingsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('corrupted: false のとき警告バナーは表示されない', async () => {
    stubFetch(false);
    renderPage();

    // 設定フォームが読み込まれるまで待つ(バナーの非表示を確認する前段)
    await waitFor(() => {
      expect(screen.getByPlaceholderText('_templates')).toBeTruthy();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: '再読込' })).toBeNull();
  });

  it('corrupted: true のとき warning バナー(role="alert")と警告文言・再読込ボタンが表示される', async () => {
    stubFetch(true);
    renderPage();

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('設定ファイル');
    expect(banner.textContent).toContain('.tsumiwiki/settings.yaml');
    expect(banner.textContent).toContain('表示されているのは初期値です');
    expect(banner.textContent).toContain('git 上の正しい過去版が上書きされます');
    expect(screen.getByRole('button', { name: '再読込' })).toBeTruthy();
  });

  it('再読込ボタンを押すと /api/library/settings が再取得される', async () => {
    const calls = stubFetch(true);
    renderPage();

    await screen.findByRole('alert');
    // 初回のGET(auth.me も含む)が完了するまで待つ
    await waitFor(() => {
      expect(calls.filter((c) => c.path === '/api/library/settings').length).toBeGreaterThanOrEqual(
        1,
      );
    });
    const before = calls.filter((c) => c.path === '/api/library/settings').length;

    fireEvent.click(screen.getByRole('button', { name: '再読込' }));

    // invalidateQueries → 再fetch が走ることを検証(呼び出し回数の増加)
    await waitFor(() => {
      const after = calls.filter((c) => c.path === '/api/library/settings').length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('添付モード選択とフォルダ名変更でパス例プレビューが更新され、保存で PUT される', async () => {
    const calls = stubFetch(false);
    renderPage();

    const folderInput = (await screen.findByPlaceholderText('attachments')) as HTMLInputElement;
    expect(folderInput.disabled).toBe(true);
    expect(screen.getByTestId('attachment-path-preview').textContent).toContain(
      '企画/image-20261118110000.png',
    );

    // doc-subfolder へ切り替え & フォルダ名変更
    fireEvent.click(screen.getByLabelText(/文書のフォルダ直下のサブフォルダ/));
    expect(folderInput.disabled).toBe(false);
    fireEvent.change(folderInput, { target: { value: 'media' } });
    expect(screen.getByTestId('attachment-path-preview').textContent).toContain(
      '企画/media/image-20261118110000.png',
    );

    // vault-folder へ切り替え
    fireEvent.click(screen.getByLabelText(/ライブラリ全体で 1 つのフォルダ/));
    expect(screen.getByTestId('attachment-path-preview').textContent).toContain(
      'media/image-20261118110000.png',
    );

    // 保存ボタンで PUT /api/library/settings に attachments が送信される
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      const putCall = calls.find((c) => c.path === '/api/library/settings' && c.method === 'PUT');
      expect(putCall).toBeDefined();
      expect((putCall?.body as { attachments: unknown }).attachments).toEqual({
        mode: 'vault-folder',
        folder: 'media',
      });
    });
  });

  it('不正なフォルダ名やテンプレフォルダ重複時はエラーを表示し PUT を送信しない', async () => {
    const calls = stubFetch(false);
    renderPage();

    const folderInput = (await screen.findByPlaceholderText('attachments')) as HTMLInputElement;
    fireEvent.click(screen.getByLabelText(/ライブラリ全体で 1 つのフォルダ/));

    for (const bad of ['', '.trash', '../out', '_templates']) {
      fireEvent.change(folderInput, { target: { value: bad } });
      expect(screen.getByTestId('attachment-folder-error')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      const saveBtn = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
      expect(saveBtn.disabled).toBe(true);
      fireEvent.click(saveBtn);
    }

    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('未保存の変更がある場合は整理プレビューが無効化され警告が出る', async () => {
    stubFetch(false);
    renderPage();

    await screen.findByTestId('reorganize-attachments-section');
    const previewBtn = screen.getByRole('button', {
      name: '整理内容をプレビュー',
    }) as HTMLButtonElement;
    expect(previewBtn.disabled).toBe(false);

    fireEvent.click(screen.getByLabelText(/ライブラリ全体で 1 つのフォルダ/));
    expect(screen.getByTestId('reorganize-dirty-warning')).toBeTruthy();
    expect(previewBtn.disabled).toBe(true);
  });

  it('プレビュー取得→確認ダイアログ→整理実行でサマリーと結果が表示される', async () => {
    const calls = stubFetch(false, {
      ...LIBRARY_SETTINGS_DEFAULTS,
      attachments: { mode: 'doc-subfolder', folder: 'attachments' },
    });
    renderPage();

    await screen.findByTestId('reorganize-attachments-section');
    const checkbox = screen.getByLabelText(
      /フォルダ横断で共有されている添付を共通フォルダ/,
    ) as HTMLInputElement;
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByRole('button', { name: '整理内容をプレビュー' }));

    const previewBox = await screen.findByTestId('reorganize-preview');
    expect(previewBox.textContent).toContain('old/pic.png');
    expect(previewBox.textContent).toContain('企画/attachments/pic-2.png');
    expect(previewBox.textContent).toContain('リネーム');
    expect(previewBox.textContent).toContain('shared.png');
    expect(previewBox.textContent).toContain('企画/メモ.md, 議事/メモ.md');
    expect(previewBox.textContent).toContain('_templates/logo.png');
    expect(previewBox.textContent).toContain('テンプレート 1 件');

    const prevCall = calls.find((c) => c.path === '/api/attachments/reorganize/preview');
    expect(prevCall?.body).toEqual({ moveSharedToCommonFolder: true });

    fireEvent.click(screen.getByRole('button', { name: '整理を実行' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('1 件の添付ファイルを移動し、1 件の文書のリンクを更新');

    fireEvent.click(screen.getByRole('button', { name: '実行する' }));
    const resultBanner = await screen.findByTestId('reorganize-result');
    expect(resultBanner.textContent).toContain('移動 1 件');
    const execCall = calls.find((c) => c.path === '/api/attachments/reorganize');
    expect(execCall?.body).toEqual({ moveSharedToCommonFolder: true });
  });

  it('ロック警告がある場合は警告バナーを表示し整理を実行を無効化する', async () => {
    stubFetch(false, LIBRARY_SETTINGS_DEFAULTS, {
      previewResponse: {
        ...SAMPLE_PREVIEW,
        lockedWarnings: [{ docPath: '企画/メモ.md', displayName: '山田' }],
      },
    });
    renderPage();

    await screen.findByTestId('reorganize-attachments-section');
    fireEvent.click(screen.getByRole('button', { name: '整理内容をプレビュー' }));

    const lockWarn = await screen.findByTestId('reorganize-lock-warning');
    expect(lockWarn.textContent).toContain('企画/メモ.md');
    expect(lockWarn.textContent).toContain('山田');
    const execBtn = screen.getByRole('button', { name: '整理を実行' }) as HTMLButtonElement;
    expect(execBtn.disabled).toBe(true);
  });
});
