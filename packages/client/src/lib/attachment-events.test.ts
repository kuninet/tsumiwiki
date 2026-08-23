import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_CHANGED_EVENT,
  dispatchAttachmentChanged,
  withCacheBuster,
} from './attachment-events';

describe('withCacheBuster', () => {
  it('version=0のときは何もしない', () => {
    expect(withCacheBuster('/api/files/a.png', 0)).toBe('/api/files/a.png');
  });

  it('クエリが無いURLには?で連結する', () => {
    expect(withCacheBuster('/api/files/a.png', 1)).toBe('/api/files/a.png?v=1');
  });

  it('クエリが既にあるURLには&で連結する', () => {
    expect(withCacheBuster('/api/embed?target=a.png&from=x.md', 2)).toBe(
      '/api/embed?target=a.png&from=x.md&v=2',
    );
  });
});

describe('dispatchAttachmentChanged', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('namesが空なら発火しない', () => {
    const listener = vi.fn();
    window.addEventListener(ATTACHMENT_CHANGED_EVENT, listener);
    dispatchAttachmentChanged([]);
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(ATTACHMENT_CHANGED_EVENT, listener);
  });

  it('namesを detail に載せてイベントを発火する', () => {
    const listener = vi.fn();
    window.addEventListener(ATTACHMENT_CHANGED_EVENT, listener);
    dispatchAttachmentChanged(['a.png', 'b.png']);
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent<{ names: string[] }>;
    expect(event.detail.names).toEqual(['a.png', 'b.png']);
    window.removeEventListener(ATTACHMENT_CHANGED_EVENT, listener);
  });
});
