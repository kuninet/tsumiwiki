import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMediaQuery } from './use-media-query';

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
        addEventListener: (_type, listener) => {
          mql.listeners.push(listener);
        },
        removeEventListener: (_type, listener) => {
          mql.listeners = mql.listeners.filter((l) => l !== listener);
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

describe('useMediaQuery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('matchMedia の初期値を返す', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'));
    expect(result.current).toBe(true);
  });

  it('change イベントで state を更新する', () => {
    const getMql = stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'));
    expect(result.current).toBe(false);

    act(() => {
      const mql = getMql();
      mql.matches = true;
      mql.listeners.forEach((l) => l({ matches: true } as MediaQueryListEvent));
    });
    expect(result.current).toBe(true);
  });

  it('matchMedia 未定義環境では false を返す', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'));
    expect(result.current).toBe(false);
  });
});
