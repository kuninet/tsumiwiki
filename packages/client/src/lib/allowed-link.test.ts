import { describe, expect, it } from 'vitest';
import { isAllowedLinkUrl, normalizeForSchemeCheck } from './allowed-link';

describe('isAllowedLinkUrl', () => {
  it('許可スキームと相対パスを許可する', () => {
    for (const url of ['https://x', 'http://x', 'mailto:a@b', 'file:///c/x.txt', 'sub/x.png', './x', '../x', '#a']) {
      expect(isAllowedLinkUrl(url), url).toBe(true);
    }
  });

  it('実行系・許可外スキームを拒否する(空白/制御文字/実体参照/パーセントエンコード偽装込み)', () => {
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'java%09script:alert(1)', 'vbscript:x', 'data:text/html;base64,AAAA', 'data:image/png;base64,AAAA', 'data:image/svg+xml;base64,AAAA', 'tel:+81', 'ftp://x/y']) {
      expect(isAllowedLinkUrl(url), JSON.stringify(url)).toBe(false);
    }
  });
});

describe('normalizeForSchemeCheck', () => {
  it('空白・制御文字を除去しパーセントデコードする', () => {
    expect(normalizeForSchemeCheck('java\tscript:')).toBe('javascript:');
    expect(normalizeForSchemeCheck('java%0Ascript:')).toBe('javascript:');
  });
  it('不正なパーセントエンコードは原文のまま返す', () => {
    expect(normalizeForSchemeCheck('a%zz')).toBe('a%zz');
  });
});
