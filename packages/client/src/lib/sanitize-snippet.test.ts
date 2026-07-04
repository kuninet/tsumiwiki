import { describe, expect, it } from 'vitest';
import { sanitizeSnippet } from './sanitize-snippet';

describe('sanitizeSnippet', () => {
  it('markタグだけをHTMLとして残す', () => {
    expect(sanitizeSnippet('前<mark>ヒット</mark>後')).toBe('前<mark>ヒット</mark>後');
  });

  it('mark以外のタグはエスケープされる(契約破れ時の二重防御)', () => {
    expect(sanitizeSnippet('<img src=x onerror=alert(1)>と<mark>語</mark>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;と<mark>語</mark>',
    );
    expect(sanitizeSnippet('<script>x</script>')).toBe('&lt;script&gt;x&lt;/script&gt;');
  });

  it('属性付きのmark風タグは許可しない', () => {
    expect(sanitizeSnippet('<mark onclick=alert(1)>x</mark>')).toBe(
      '&lt;mark onclick=alert(1)&gt;x</mark>',
    );
  });
});
