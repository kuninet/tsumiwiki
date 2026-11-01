import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText, copyTextWithToast } from './clipboard';

function stubClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

// jsdom には execCommand が無いので、copy イベントを発火する実装を模擬する
function stubExecCommand(impl: () => boolean) {
  (document as unknown as { execCommand: () => boolean }).execCommand = impl;
}

afterEach(() => {
  delete (document as unknown as { execCommand?: unknown }).execCommand;
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
});

describe('copyText', () => {
  it('execCommand が使えれば同期経路を使い、writeText は呼ばない', async () => {
    const writeText = vi.fn();
    stubClipboard({ writeText });
    const setData = vi.fn();
    stubExecCommand(() => {
      const ev = new Event('copy');
      (ev as unknown as { clipboardData: unknown }).clipboardData = { setData };
      document.dispatchEvent(ev);
      return true;
    });
    await expect(copyText('a/b.md')).resolves.toBe(true);
    expect(setData).toHaveBeenCalledWith('text/plain', 'a/b.md');
    expect(writeText).not.toHaveBeenCalled();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('execCommand が false を返したら writeText に落ちる', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    stubExecCommand(() => false);
    await expect(copyText('a/b.md')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('a/b.md');
  });

  it('execCommand が例外を投げたら writeText に落ちる', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    stubExecCommand(() => {
      throw new Error('x');
    });
    await expect(copyText('a/b.md')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('a/b.md');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('execCommand も navigator.clipboard も無ければ false(LAN の http 相当)', async () => {
    stubClipboard(undefined);
    await expect(copyText('a/b.md')).resolves.toBe(false);
  });

  it('writeText が reject したら false', async () => {
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    await expect(copyText('a/b.md')).resolves.toBe(false);
  });
});

describe('copyTextWithToast', () => {
  it('成功で既定の文言、第3引数があればその文言を出す', async () => {
    stubClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    const show = vi.fn();
    copyTextWithToast('a.md', show);
    await waitFor(() => expect(show).toHaveBeenCalledWith('success', 'パスをコピーしました'));
    const show2 = vi.fn();
    copyTextWithToast('a.md', show2, 'URLをコピーしました');
    await waitFor(() => expect(show2).toHaveBeenCalledWith('success', 'URLをコピーしました'));
  });

  it('失敗で error トーストを出す', async () => {
    stubClipboard(undefined);
    const show = vi.fn();
    copyTextWithToast('a.md', show);
    await waitFor(() => expect(show).toHaveBeenCalledWith('error', 'コピーに失敗しました'));
  });
});
