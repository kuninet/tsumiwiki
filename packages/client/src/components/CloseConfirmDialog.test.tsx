import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTabActions } from '../lib/tab-actions-registry';
import { getActivePaneTabsFromState, useTabsStore } from '../stores/tabs';
import { useToastStore } from '../stores/toast';
import { CloseConfirmDialog } from './CloseConfirmDialog';

function renderDialog() {
  return render(
    <MemoryRouter>
      <CloseConfirmDialog />
    </MemoryRouter>,
  );
}

describe('CloseConfirmDialog', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useToastStore.setState({ toast: null });
  });
  afterEach(() => cleanup());

  it('pendingCloseId が null のときは描画しない', () => {
    const { container } = renderDialog();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('pendingCloseId が立っていれば dirty タブ用のダイアログを描画する', () => {
    useTabsStore.getState().openDoc('a.md');
    useTabsStore.getState().markDirty('a.md', true);
    useTabsStore.getState().requestClose('a.md');
    renderDialog();
    expect(screen.getByRole('heading', { name: '未保存の変更があります' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '保存して閉じる' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '破棄して閉じる' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeTruthy();
  });

  it('「キャンセル」で pendingCloseId が null に戻り、タブは閉じない', () => {
    useTabsStore.getState().openDoc('a.md');
    useTabsStore.getState().markDirty('a.md', true);
    useTabsStore.getState().requestClose('a.md');
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(useTabsStore.getState().pendingClose?.path ?? null).toBeNull();
    expect(getActivePaneTabsFromState(useTabsStore.getState())).toHaveLength(1);
  });

  it('「破棄して閉じる」で discard 呼び出し → タブが閉じる', async () => {
    useTabsStore.getState().openDoc('a.md');
    useTabsStore.getState().markDirty('a.md', true);
    useTabsStore.getState().requestClose('a.md');
    const discard = vi.fn(() => Promise.resolve());
    registerTabActions('a.md', {
      save: () => Promise.resolve(true),
      discard,
    });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '破棄して閉じる' }));
    await waitFor(() => {
      expect(getActivePaneTabsFromState(useTabsStore.getState())).toHaveLength(0);
    });
    expect(discard).toHaveBeenCalled();
    expect(useTabsStore.getState().pendingClose?.path ?? null).toBeNull();
  });

  it('「保存して閉じる」で save が true を返したらタブが閉じる', async () => {
    useTabsStore.getState().openDoc('a.md');
    useTabsStore.getState().markDirty('a.md', true);
    useTabsStore.getState().requestClose('a.md');
    const save = vi.fn(() => Promise.resolve(true));
    registerTabActions('a.md', {
      save,
      discard: () => Promise.resolve(),
    });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '保存して閉じる' }));
    await waitFor(() => {
      expect(getActivePaneTabsFromState(useTabsStore.getState())).toHaveLength(0);
    });
    expect(save).toHaveBeenCalled();
  });

  it('save が false を返したらタブは閉じずトーストを出す(R1)', async () => {
    useTabsStore.getState().openDoc('a.md');
    useTabsStore.getState().markDirty('a.md', true);
    useTabsStore.getState().requestClose('a.md');
    const save = vi.fn(() => Promise.resolve(false));
    registerTabActions('a.md', {
      save,
      discard: () => Promise.resolve(),
    });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '保存して閉じる' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalled();
    });
    expect(getActivePaneTabsFromState(useTabsStore.getState())).toHaveLength(1);
    expect(useToastStore.getState().toast).toMatchObject({ kind: 'error' });
  });

  it('レジストリに登録されていない path でも破棄は成立する(タブだけ閉じる)', async () => {
    useTabsStore.getState().openDoc('a.md');
    useTabsStore.getState().markDirty('a.md', true);
    useTabsStore.getState().requestClose('a.md');
    // 何も register しない
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '破棄して閉じる' }));
    await waitFor(() => {
      expect(getActivePaneTabsFromState(useTabsStore.getState())).toHaveLength(0);
    });
  });
});
