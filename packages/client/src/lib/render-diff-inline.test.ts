import { describe, expect, it } from 'vitest';
import { renderDiffInline } from './render-diff-inline';

describe('renderDiffInline', () => {
  it('プレーンテキストはエスケープだけされる', () => {
    expect(renderDiffInline('普通の <文> & \'テキスト\'')).toBe(
      '普通の &lt;文&gt; &amp; &#39;テキスト&#39;',
    );
  });

  it('inline code はエスケープ後の中身をそのまま <code> で包む', () => {
    expect(renderDiffInline('前 `code` 後')).toBe('前 <code>code</code> 後');
  });

  it('bold は <strong>、italic は <em> に変換される', () => {
    expect(renderDiffInline('**太字** と *斜体* が混在')).toBe(
      '<strong>太字</strong> と <em>斜体</em> が混在',
    );
  });

  it('wikilink は class="wikilink" を持つ span で表示される', () => {
    expect(renderDiffInline('[[設計]] を参照')).toBe(
      '<span class="wikilink">設計</span> を参照',
    );
  });

  it('inline code 内の * は装飾対象にならない(先に <code> で保護)', () => {
    expect(renderDiffInline('`**not bold**` は装飾されない')).toBe(
      '<code>**not bold**</code> は装飾されない',
    );
  });

  it('危険な生HTMLは常にエスケープされる', () => {
    expect(renderDiffInline('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });
});
