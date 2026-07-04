import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('確定ボタンでonConfirmが呼ばれる', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog title="文書の削除" message="削除しますか?" onConfirm={onConfirm} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('キャンセルボタンでonCancelが呼ばれる', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog title="t" message="m" onConfirm={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
