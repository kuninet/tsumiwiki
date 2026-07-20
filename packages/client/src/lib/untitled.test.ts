import { describe, expect, it } from 'vitest';
import { pickUniqueUntitledTitle, UNTITLED_BASE } from './untitled';

describe('pickUniqueUntitledTitle', () => {
  it('タイトルが空なら 無題', () => {
    expect(pickUniqueUntitledTitle([])).toBe(UNTITLED_BASE);
  });

  it('無題 が使われていたら 無題(1)', () => {
    expect(pickUniqueUntitledTitle(['無題'])).toBe('無題(1)');
  });

  it('無題 と 無題(1) が使われていたら 無題(2)', () => {
    expect(pickUniqueUntitledTitle(['無題', '無題(1)'])).toBe('無題(2)');
  });

  it('無題(1) だけあれば 無題(既定名は空いている)', () => {
    expect(pickUniqueUntitledTitle(['無題(1)'])).toBe(UNTITLED_BASE);
  });

  it('関係ないタイトルは無視', () => {
    expect(pickUniqueUntitledTitle(['メモ', '議事録'])).toBe(UNTITLED_BASE);
  });

  it('無題〜無題(999) まで詰まっていたら timestamp サフィックス', () => {
    const many = [UNTITLED_BASE, ...Array.from({ length: 999 }, (_, i) => `無題(${i + 1})`)];
    const result = pickUniqueUntitledTitle(many);
    expect(result).toMatch(/^無題\(\d+\)$/);
    expect(many).not.toContain(result);
  });
});
