import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentLightbox } from './AttachmentLightbox';

afterEach(() => {
  cleanup();
});

describe('AttachmentLightbox(#211)', () => {
  it('role="dialog"が出て初期フォーカスは「閉じる」ボタン', () => {
    render(
      <AttachmentLightbox kind="image" src="/api/embed?target=a.png" onClose={vi.fn()} />,
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '閉じる' }));
  });

  it('EscapeでonCloseが呼ばれる', () => {
    const onClose = vi.fn();
    render(<AttachmentLightbox kind="image" src="/api/embed?target=a.png" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('背景クリックでonCloseが呼ばれ、内側(メディア領域)クリックでは呼ばれない', () => {
    const onClose = vi.fn();
    render(<AttachmentLightbox kind="image" src="/api/embed?target=a.png" onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    // 内側 img は「mousedown→click」が同じ要素で完結するため閉じない
    fireEvent.mouseDown(screen.getByRole('img'));
    fireEvent.click(screen.getByRole('img'));
    expect(onClose).not.toHaveBeenCalled();
    // 背景 mousedown → 背景 click(共通経路)で閉じる
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('内側で mousedown → 背景で mouseup+click しても閉じない(ドラッグアウト誤閉じ防止)', () => {
    const onClose = vi.fn();
    render(<AttachmentLightbox kind="image" src="/api/embed?target=a.png" onClose={onClose} />);
    // 画像上で押下し、そのままドラッグ状態で背景上に離すとブラウザは共通祖先(overlay)で click を発火する。
    // mousedown 発生元が背景でないので閉じないこと(レビュー重大#4)
    fireEvent.mouseDown(screen.getByRole('img'));
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('unmountでbody.style.overflowが復元され、開く直前にフォーカスされていた要素へ戻る', () => {
    const original = document.body.style.overflow;
    const button = document.createElement('button');
    button.textContent = 'trigger';
    document.body.appendChild(button);
    button.focus();
    expect(document.activeElement).toBe(button);
    const { unmount } = render(
      <AttachmentLightbox kind="image" src="/api/embed?target=a.png" onClose={vi.fn()} />,
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe(original);
    // レビュー重大#2: 閉じた後は開く直前の要素にフォーカスが戻る
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it('PDFはiframeで表示し、Tabトラップから外すためtabIndex=-1が付く', () => {
    render(
      <AttachmentLightbox
        kind="pdf"
        src="/api/files/report.pdf#page=3"
        alt="report.pdf"
        onClose={vi.fn()}
      />,
    );
    const iframe = document.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe!.getAttribute('src')).toBe('/api/files/report.pdf#page=3');
    // レビュー重大#3: iframe に一度Tabが入ると戻ってこないため、フォーカス受取から外す
    expect(iframe!.getAttribute('tabindex')).toBe('-1');
  });

  it('alt未指定でも aria-label は URL 全体でなく basename(デコード済)になる', () => {
    render(
      <AttachmentLightbox
        kind="image"
        src="/api/files/%E3%83%A1%E3%83%A2.png"
        onClose={vi.fn()}
      />,
    );
    // レビュー軽微#12: SR が URL を読み上げないよう basename にフォールバックする
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('メモ.png');
  });
});
