import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatePickerDialog } from './DatePickerDialog';

describe('DatePickerDialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('open=falseなら何も描画しない', () => {
    render(
      <DatePickerDialog open={false} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('open=trueならinitialDateを初期値としてinputが表示される', () => {
    render(
      <DatePickerDialog open={true} initialDate="2026-08-01" onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );
    const input = screen.getByLabelText('日付') as HTMLInputElement;
    expect(input.value).toBe('2026-08-01');
  });

  it('OKクリックでonConfirmに選択した日付が渡される', () => {
    const onConfirm = vi.fn();
    render(
      <DatePickerDialog
        open={true}
        initialDate="2026-08-01"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.change(screen.getByLabelText('日付'), { target: { value: '2026-08-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(onConfirm).toHaveBeenCalledWith('2026-08-10');
  });

  it('キャンセルクリックでonCancelが呼ばれる', () => {
    const onCancel = vi.fn();
    render(
      <DatePickerDialog open={true} initialDate="2026-08-01" onCancel={onCancel} onConfirm={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('busy=trueならOKボタンがdisabledになる', () => {
    render(
      <DatePickerDialog
        open={true}
        initialDate="2026-08-01"
        busy={true}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const okButton = screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement;
    expect(okButton.disabled).toBe(true);
    expect(okButton.getAttribute('aria-busy')).toBe('true');
  });
});
