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
  scale: number;
  listeners: Record<string, Array<() => void>>;
  addEventListener: (t: string, l: () => void) => void;
  removeEventListener: (t: string, l: () => void) => void;
}

function stubVisualViewport(initial: {
  height: number;
  offsetTop?: number;
  scale?: number;
}): StubVV {
  const vv: StubVV = {
    height: initial.height,
    offsetTop: initial.offsetTop ?? 0,
    scale: initial.scale ?? 1,
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

  it('pinch zoom(scale > 1)時は vv.height を scale で正規化してキーボード分だけ検出する', () => {
    // scale=2 でズームイン → vv.height は CSS px 表示なので layout viewport の半分
    // (400)を返す。scale を掛けないと 800 - 400 = 400 を「キーボード」と誤検出する。
    // 実際にはキーボードが 300px 出ている状態: vv.height = (800-300)/2 = 250
    stubMatchMedia(true);
    stubVisualViewport({ height: 250, scale: 2 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const { result } = renderHook(() => useVirtualKeyboard());
    // 250 * 2 = 500 → 800 - 500 = 300 が真のキーボード高さ
    expect(result.current.keyboardOffset).toBe(300);
  });

  it('バウンススクロールで offsetTop が負になっても keyboardOffset を過大計算しない', () => {
    // iOS Safari rubber-band: vv.offsetTop が一時的に負(例 -30)になり、その値のまま
    // resize が固定される既知挙動。負のまま計算すると keyboardOffset = 800-(500+(-30))=330
    // と過大化してツールバーが吊り上がる。Math.max(0, offsetTop) で真値 300 を保つ。
    stubMatchMedia(true);
    stubVisualViewport({ height: 500, offsetTop: -30 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const { result } = renderHook(() => useVirtualKeyboard());
    expect(result.current.keyboardOffset).toBe(300);
  });

  it('pinch zoom で scale > 1 だがキーボード無しなら 0 を返す(誤検出しない)', () => {
    // scale=2 ノーキーボード: vv.height = 400 (layout 800 / 2), scale=2
    // 400 * 2 = 800 → 800 - 800 = 0
    stubMatchMedia(true);
    stubVisualViewport({ height: 400, scale: 2 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const { result } = renderHook(() => useVirtualKeyboard());
    expect(result.current.keyboardOffset).toBe(0);
    expect(result.current.visible).toBe(false);
  });

  it('scale が 0 / 未定義でも 1 に fallback して過大検出しない', () => {
    stubMatchMedia(true);
    // 破損値: scale=0(実装バグ想定)。0 で掛けると vv.height*0=0 → offset=innerHeight で
    // 常に閾値超過 → キーボード出っぱなし誤検知になる。防御して 1 扱い。
    stubVisualViewport({ height: 800, scale: 0 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const { result } = renderHook(() => useVirtualKeyboard());
    expect(result.current.keyboardOffset).toBe(0);
    expect(result.current.visible).toBe(false);
  });

  it('resize 遷移で scale / offsetTop の変化が正しく反映される', () => {
    // 遷移カバレッジ: (1) scale=1 & offsetTop=0 で通常キーボード → (2) scale=2 & offsetTop=0 で
    // ピンチ拡大 → (3) offsetTop=-30 でバウンス → (4) offsetTop=0 で復元、を順に emit して
    // 各段階で keyboardOffset が正しい値を保つことを確認する。
    stubMatchMedia(true);
    const vv = stubVisualViewport({ height: 500 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const { result } = renderHook(() => useVirtualKeyboard());
    expect(result.current.keyboardOffset).toBe(300); // (1)

    act(() => {
      vv.height = 250;
      vv.scale = 2;
      vv.listeners.resize?.forEach((l) => l());
    });
    expect(result.current.keyboardOffset).toBe(300); // (2) 250*2=500 → 800-500=300

    act(() => {
      vv.height = 500;
      vv.scale = 1;
      vv.offsetTop = -30;
      vv.listeners.resize?.forEach((l) => l());
    });
    expect(result.current.keyboardOffset).toBe(300); // (3) clamp で -30 → 0 扱い

    act(() => {
      vv.offsetTop = 0;
      vv.listeners.resize?.forEach((l) => l());
    });
    expect(result.current.keyboardOffset).toBe(300); // (4) 復元
  });
});
