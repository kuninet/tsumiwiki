import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHorizontalResize } from './use-horizontal-resize';

describe('useHorizontalResize (C-1)', () => {
  beforeEach(() => {
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  });

  afterEach(() => {
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  });

  it('C-1-1: side:left で mousedown 後 mousemove すると onResize(clientX) が呼ばれスタイルが設定される', () => {
    const onResize = vi.fn();
    const { result } = renderHook(() =>
      useHorizontalResize({ side: 'left', onResize }),
    );

    const preventDefault = vi.fn();
    result.current.onMouseDown({
      preventDefault,
    } as unknown as React.MouseEvent);

    expect(preventDefault).toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe('none');
    expect(document.body.style.cursor).toBe('col-resize');

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300 }));
    expect(onResize).toHaveBeenCalledWith(300);
  });

  it('C-1-2: side:right で window.innerWidth=1280 のとき onResize(innerWidth - clientX) が呼ばれる', () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1280,
    });

    const onResize = vi.fn();
    const { result } = renderHook(() =>
      useHorizontalResize({ side: 'right', onResize }),
    );

    result.current.onMouseDown({
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent);

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 900 }));
    expect(onResize).toHaveBeenCalledWith(380);

    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: originalInnerWidth,
    });
  });

  it('C-1-3: ドラッグ中に mouseup するとスタイルがクリアされ以後の mousemove で onResize が呼ばれない', () => {
    const onResize = vi.fn();
    const { result } = renderHook(() =>
      useHorizontalResize({ side: 'left', onResize }),
    );

    result.current.onMouseDown({
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent);

    window.dispatchEvent(new MouseEvent('mouseup'));
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');

    onResize.mockClear();
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }));
    expect(onResize).not.toHaveBeenCalled();
  });

  it('C-1-4: mousedown していない場合 mousemove で onResize は呼ばれない', () => {
    const onResize = vi.fn();
    renderHook(() => useHorizontalResize({ side: 'left', onResize }));

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300 }));
    expect(onResize).not.toHaveBeenCalled();
  });

  it('C-1-5: ドラッグ中に hook をアンマウントするとスタイルが元に戻りリスナーが解除される', () => {
    const onResize = vi.fn();
    const { result, unmount } = renderHook(() =>
      useHorizontalResize({ side: 'left', onResize }),
    );

    result.current.onMouseDown({
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent);

    expect(document.body.style.userSelect).toBe('none');
    expect(document.body.style.cursor).toBe('col-resize');

    unmount();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');

    onResize.mockClear();
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300 }));
    expect(onResize).not.toHaveBeenCalled();
  });
});
