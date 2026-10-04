// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabsStore } from '../stores/tabs';
import { useToastStore } from '../stores/toast';
import { useUserSettingsStore } from '../stores/user-settings';
import { NewDocFromLinkDialog, type NewDocFromLinkDialogProps } from './NewDocFromLinkDialog';

function mockCreateDocApi(response: { path: string; updatedAt: string }, delayMs = 0) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(response),
            });
          }, delayMs);
        }),
    ),
  );
}

function renderDialog(props: Partial<NewDocFromLinkDialogProps> = {}) {
  const onCancel = props.onCancel ?? vi.fn();
  const onCreated = props.onCreated ?? vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NewDocFromLinkDialog
          wikilinkTarget={props.wikilinkTarget ?? '新しい文書'}
          sourceDocPath={props.sourceDocPath ?? '業務/メモ.md'}
          onCancel={onCancel}
          onCreated={onCreated}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return { ...result, onCancel, onCreated };
}

describe('NewDocFromLinkDialog', () => {
  beforeEach(() => {
    useUserSettingsStore.setState({
      unresolvedLinkFolder: 'same-folder',
    });
    useUserSettingsStore.persist.clearStorage();
    useToastStore.setState({ toast: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('初期値は個人設定 unresolvedLinkFolder に従い、プレビューを表示する', () => {
    renderDialog();

    const sameRadio = screen.getByRole('radio', { name: 'リンク元と同じフォルダ' }) as HTMLInputElement;
    const rootRadio = screen.getByRole('radio', { name: 'ルート' }) as HTMLInputElement;

    expect(sameRadio.checked).toBe(true);
    expect(rootRadio.checked).toBe(false);
    expect(screen.getByText('業務/新しい文書.md')).toBeTruthy();
  });

  it('個人設定が root の場合、初期値も root になる', () => {
    useUserSettingsStore.setState({ unresolvedLinkFolder: 'root' });
    renderDialog();

    const rootRadio = screen.getByRole('radio', { name: 'ルート' }) as HTMLInputElement;
    expect(rootRadio.checked).toBe(true);
    expect(screen.getByText('新しい文書.md')).toBeTruthy();
  });

  it('ラジオを切り替えるとファイルパスのプレビューが追随する', () => {
    renderDialog();

    expect(screen.getByText('業務/新しい文書.md')).toBeTruthy();

    const rootRadio = screen.getByRole('radio', { name: 'ルート' });
    fireEvent.click(rootRadio);

    expect(screen.getByText('新しい文書.md')).toBeTruthy();

    const sameRadio = screen.getByRole('radio', { name: 'リンク元と同じフォルダ' });
    fireEvent.click(sameRadio);

    expect(screen.getByText('業務/新しい文書.md')).toBeTruthy();
  });

  it('作成時に選んだラジオ値が個人設定に保存され、キャンセル時は保存されない', async () => {
    mockCreateDocApi({ path: '新しい文書.md', updatedAt: '2026-10-04T00:00:00Z' });

    // 1. キャンセル時
    const { onCancel, unmount } = renderDialog();
    const rootRadio = screen.getByRole('radio', { name: 'ルート' });
    fireEvent.click(rootRadio);
    expect(useUserSettingsStore.getState().unresolvedLinkFolder).toBe('same-folder');

    const cancelBtn = screen.getByRole('button', { name: 'キャンセル' });
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(useUserSettingsStore.getState().unresolvedLinkFolder).toBe('same-folder');

    unmount();

    // 2. 作成時
    const { onCreated } = renderDialog();
    const rootRadio2 = screen.getByRole('radio', { name: 'ルート' });
    fireEvent.click(rootRadio2);

    const submitBtn = screen.getByRole('button', { name: '作成して開く' });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith('新しい文書.md');
    });
    expect(useUserSettingsStore.getState().unresolvedLinkFolder).toBe('root');
  });

  it('Escape キーでキャンセルされる', () => {
    const { onCancel } = renderDialog();
    const dialog = screen.getByRole('dialog');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('isPending 中はボタンが無効化され、連打しても多重リクエストが発生しない', async () => {
    mockCreateDocApi({ path: '業務/新しい文書.md', updatedAt: '2026-10-04T00:00:00Z' }, 100);
    renderDialog();

    const submitBtn = screen.getByRole('button', { name: '作成して開く' });
    const cancelBtn = screen.getByRole('button', { name: 'キャンセル' });

    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(submitBtn.hasAttribute('disabled')).toBe(true);
      expect(cancelBtn.hasAttribute('disabled')).toBe(true);
    });

    // 送信中に連打しても多重実行されない
    fireEvent.click(submitBtn);
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '作成中...' })).toBeNull();
    });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('作成APIがエラー(400等)を返した場合はエラートーストを表示し、ダイアログは開いたままにする', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: () =>
            Promise.resolve({
              error: { code: 'VALIDATION_ERROR', message: '不正なフォルダ名です' },
            }),
        }),
      ),
    );

    const { onCreated } = renderDialog();

    const submitBtn = screen.getByRole('button', { name: '作成して開く' });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      const toast = useToastStore.getState().toast;
      expect(toast?.kind).toBe('error');
      expect(toast?.message).toBe('不正なフォルダ名です');
    });

    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('連番付きパスで作成された場合は警告トーストが出る', async () => {
    mockCreateDocApi({ path: '業務/新しい文書 (2).md', updatedAt: '2026-10-04T00:00:00Z' });
    const { onCreated } = renderDialog();

    const submitBtn = screen.getByRole('button', { name: '作成して開く' });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith('業務/新しい文書 (2).md');
    });

    const toast = useToastStore.getState().toast;
    expect(toast?.kind).toBe('warning');
    expect(toast?.message).toBe('リンク名と異なる名前で作成されました');
  });

  it('禁止文字が含まれる場合は警告が表示され、作成自体は許可される', () => {
    renderDialog({ wikilinkTarget: 'A:B' });

    expect(screen.getByText(/「:」などファイル名に使えない文字は全角に置き換えて作成されます/)).toBeTruthy();
    const submitBtn = screen.getByRole('button', { name: '作成して開く' });
    expect(submitBtn.hasAttribute('disabled')).toBe(false);
  });

  it('作成成功時に pinned タブで開かれる', async () => {
    mockCreateDocApi({ path: '業務/新しい文書.md', updatedAt: '2026-10-04T00:00:00Z' });
    const openDocSpy = vi.spyOn(useTabsStore.getState(), 'openDoc');
    renderDialog();

    const submitBtn = screen.getByRole('button', { name: '作成して開く' });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(openDocSpy).toHaveBeenCalledWith('業務/新しい文書.md', { pinned: true });
    });
  });
});
