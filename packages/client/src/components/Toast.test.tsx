import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../stores/toast';
import { Toast } from './Toast';

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    useToastStore.setState({ toast: null });
  });

  it('successは3秒後に自動で消える', () => {
    useToastStore.getState().show('success', '保存しました');
    render(<Toast />);

    expect(screen.getByText('保存しました')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.queryByText('保存しました')).toBeNull();
  });

  it('errorは自動で消えず、×ボタンで手動クローズできる', () => {
    useToastStore.getState().show('error', '保存に失敗しました');
    render(<Toast />);

    expect(screen.getByText('保存に失敗しました')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText('保存に失敗しました')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByText('保存に失敗しました')).toBeNull();
  });

  it('操作ボタン付きは自動で消えず、押すとonClickが呼ばれる(#251の更新通知)', () => {
    const onClick = vi.fn();
    useToastStore
      .getState()
      .show('info', '新しいバージョンがあります', { label: '再読み込み', onClick });
    render(<Toast />);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText('新しいバージョンがあります')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '再読み込み' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
