import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptDialog } from './PromptDialog';

describe('PromptDialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('入力して確定すると入力値でonConfirmが呼ばれる', () => {
    const onConfirm = vi.fn();
    render(
      <PromptDialog
        title="新規文書"
        label="タイトル"
        confirmLabel="作成"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('タイトル'), { target: { value: '議事録' } });
    fireEvent.click(screen.getByRole('button', { name: '作成' }));

    expect(onConfirm).toHaveBeenCalledWith('議事録');
  });

  it('空欄のまま確定してもonConfirmは呼ばれない', () => {
    const onConfirm = vi.fn();
    render(<PromptDialog title="t" label="l" onConfirm={onConfirm} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'OK' }));

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('キャンセルボタンでonCancelが呼ばれる', () => {
    const onCancel = vi.fn();
    render(<PromptDialog title="t" label="l" onConfirm={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
