import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVirtualKeyboard } from './use-virtual-keyboard';

interface StubMQL {
  matches: boolean;
  media: string;
  listeners: Array<(e: MediaQueryListEvent) => void>;
  addEventListener: (t: string, l: (e: MediaQueryListEvent) => void) => void;
  removeEventListener: (t: string, l: (e: MediaQueryListEvent) => void) => void;
  addListener: () => void;
  removeListener: () => void;
  dispatchEvent: () => boolean;
  onchange: null;
}

function stubMatchMedia(initial: boolean): () => StubMQL {
  const mqls: StubMQL[] = [];
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => {
      const mql: StubMQL = {
        matches: initial,
        media: query,
        listeners: [],
        addEventListener: (_t, l) => {
          mql.listeners.push(l);
        },
        removeEventListener: (_t, l) => {
          mql.listeners = mql.listeners.filter((x) => x !== l);
        },
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
        onchange: null,
      };
      mqls.push(mql);
      return mql;
    }),
  );
  return () => mqls[mqls.length - 1];
}

interface StubVV {
  height: number;
  offsetTop: number;
  listeners: Record<string, Array<() => void>>;
  addEventListener: (t: string, l: () => void) => void;
  removeEventListener: (t: string, l: () => void) => void;
}

function stubVisualViewport(initial: { height: number; offsetTop?: number }): StubVV {
  const vv: StubVV = {
    height: initial.height,
    offsetTop: initial.offsetTop ?? 0,
    listeners: {},
    addEventListener: (t, l) => {
      (vv.listeners[t] ??= []).push(l);
    },
    removeEventListener: (t, l) => {
      vv.listeners[t] = (vv.listeners[t] ?? []).filter((x) => x !== l);
    },
  };
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: vv,
  });
  return vv;
}

describe('useVirtualKeyboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: undefined,
    });
    cleanup();
  });

  it('タッチ端末でなければ visible/bottomOffset は常に 0/false', () => {
    stubMatchMedia(false);
    stubVisualViewport({ height: 400 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const { result } = renderHook(() => useVirtualKeyboard());
    expect(result.current.isTouch).toBe(false);
    expect(result.current.visible).toBe(false);
    expect(result.current.bottomOffset).toBe(0);
    expect(result.current.keyboardOffset).toBe(0);
  });

  it('タッチ端末で visualViewport が縮小すると visible=true/bottomOffset にオフセットが入る', () => {
    stubMatchMedia(true);
    const vv = stubVisualViewport({ height: 500 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const { result } = renderHook(() => useVirtualKeyboard());
    expect(result.current.isTouch).toBe(true);
    expect(result.current.visible).toBe(true);
    expect(result.current.bottomOffset).toBe(300);
    expect(result.current.keyboardOffset).toBe(300);

    // キーボードが閉じたケース(resize で height が回復)
    act(() => {
      vv.height = 800;
      vv.listeners.resize?.forEach((l) => l());
    });
    expect(result.current.visible).toBe(false);
    expect(result.current.bottomOffset).toBe(0);
  });

  it('scroll イベントだけでも height 変化を拾える(iOS Safari 対策)', () => {
    stubMatchMedia(true);
    const vv = stubVisualViewport({ height: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const { result } = renderHook(() => useVirtualKeyboard());
    expect(result.current.visible).toBe(false);

    act(() => {
      vv.height = 500;
      vv.listeners.scroll?.forEach((l) => l());
    });
    expect(result.current.bottomOffset).toBe(300);
  });

  it('縮小が閾値(150px)以下ならキーボードとみなさず 0 を返す', () => {
    stubMatchMedia(true);
    stubVisualViewport({ height: 700 }); // 800-700=100 < 150
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const { result } = renderHook(() => useVirtualKeyboard());
    expect(result.current.visible).toBe(false);
    expect(result.current.bottomOffset).toBe(0);
  });

  it('offsetTop がある場合(iOS で上部にずれる)も高さ計算に含める', () => {
    stubMatchMedia(true);
    stubVisualViewport({ height: 500, offsetTop: 50 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const { result } = renderHook(() => useVirtualKeyboard());
    expect(result.current.bottomOffset).toBe(250);
  });

  it('isTouch が true→false にフリップすると keyboardOffset がリセットされ vv リスナーが外れる', () => {
    const getMql = stubMatchMedia(true);
    const vv = stubVisualViewport({ height: 500 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const { result } = renderHook(() => useVirtualKeyboard());
    expect(result.current.bottomOffset).toBe(300);
    expect(vv.listeners.resize?.length ?? 0).toBeGreaterThan(0);

    act(() => {
      const mql = getMql();
      mql.matches = false;
      mql.listeners.forEach((l) => l({ matches: false } as MediaQueryListEvent));
    });

    expect(result.current.isTouch).toBe(false);
    expect(result.current.bottomOffset).toBe(0);
    expect(vv.listeners.resize?.length ?? 0).toBe(0);
    expect(vv.listeners.scroll?.length ?? 0).toBe(0);
  });

  it('unmount 後に vv イベントが発火しても壊れない(リスナーが正しく解除される)', () => {
    stubMatchMedia(true);
    const vv = stubVisualViewport({ height: 500 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const { unmount } = renderHook(() => useVirtualKeyboard());
    expect(vv.listeners.resize?.length ?? 0).toBeGreaterThan(0);

    unmount();
    expect(vv.listeners.resize?.length ?? 0).toBe(0);
    expect(vv.listeners.scroll?.length ?? 0).toBe(0);

    // 万一残っていても呼び出しでエラーにならないこと(cleanup 済みなので実質何もしない)
    expect(() => {
      vv.height = 800;
      vv.listeners.resize?.forEach((l) => l());
    }).not.toThrow();
  });

  it('matchMedia 未定義環境では isTouch=false / 全て 0', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => useVirtualKeyboard());
    expect(result.current.isTouch).toBe(false);
    expect(result.current.visible).toBe(false);
    expect(result.current.bottomOffset).toBe(0);
  });

  it('visualViewport 未定義環境ではオフセット計算は行わないがクラッシュしない', () => {
    stubMatchMedia(true);
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
    const { result } = renderHook(() => useVirtualKeyboard());
    expect(result.current.isTouch).toBe(true);
    expect(result.current.bottomOffset).toBe(0);
  });
});
