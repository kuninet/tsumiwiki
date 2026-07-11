// @vitest-environment jsdom
import type { DocSummary } from '@tsumiwiki/shared';
import { describe, expect, it, vi } from 'vitest';
import { handleWikilinkClick } from './handle-wikilink-click';

function makeDocs(): DocSummary[] {
  return [
    { path: '設計.md', title: '設計', folder: '', updatedAt: '2026-07-01T00:00:00+09:00' },
  ];
}

function makeWikilinkEl(target: string, label = target): HTMLElement {
  const span = document.createElement('span');
  span.className = 'wikilink';
  span.setAttribute('data-type', 'wikilink');
  span.setAttribute('data-target', target);
  span.textContent = label;
  return span;
}

describe('handleWikilinkClick', () => {
  it('span[data-type="wikilink"] を直接クリックすると navigate を呼び true を返す', () => {
    const navigate = vi.fn();
    const showToast = vi.fn();
    const span = makeWikilinkEl('設計');

    const handled = handleWikilinkClick(span, makeDocs(), navigate, showToast);

    expect(handled).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/doc/%E8%A8%AD%E8%A8%88.md');
    expect(showToast).not.toHaveBeenCalled();
  });

  it('span の子要素(closest 経路)からでも wikilink として拾える', () => {
    const navigate = vi.fn();
    const showToast = vi.fn();
    const span = makeWikilinkEl('設計');
    // 子孫要素からのイベントを模す(closest で辿れる想定)
    const inner = document.createElement('em');
    span.appendChild(inner);

    const handled = handleWikilinkClick(inner, makeDocs(), navigate, showToast);

    expect(handled).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('リンク先が解決できないときは navigate を呼ばずエラートーストを出す(それでも処理済み=true)', () => {
    const navigate = vi.fn();
    const showToast = vi.fn();
    const span = makeWikilinkEl('存在しない');

    const handled = handleWikilinkClick(span, makeDocs(), navigate, showToast);

    expect(handled).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('error', 'リンク先が見つかりません');
  });

  it('wikilink 以外の要素をクリックしたときは false を返し何もしない', () => {
    const navigate = vi.fn();
    const showToast = vi.fn();
    const div = document.createElement('div');
    div.textContent = 'ただの文字';

    const handled = handleWikilinkClick(div, makeDocs(), navigate, showToast);

    expect(handled).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('target が Element でない(null 等)なら false を返す', () => {
    const navigate = vi.fn();
    const showToast = vi.fn();

    expect(handleWikilinkClick(null, makeDocs(), navigate, showToast)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
