import { describe, expect, it } from 'vitest';
import { removeInlineTag, renameInlineTag } from './inline-tag-rewrite';

describe('renameInlineTag', () => {
  it('行頭・空白直後の #tag を置き換える', () => {
    const body = '#foo は先頭のタグ\n本文 #foo です';
    expect(renameInlineTag(body, 'foo', 'bar')).toBe('#bar は先頭のタグ\n本文 #bar です');
  });

  it('開き括弧直後の #tag も対象', () => {
    expect(renameInlineTag('参照(#foo)', 'foo', 'bar')).toBe('参照(#bar)');
  });

  it('部分一致で誤爆しない(#fooBar は #foo として置換されない)', () => {
    // #fooBar は続く「B」が [\p{L}\p{N}_/-] に当たるため境界にならず一致しない
    expect(renameInlineTag('#fooBar のテスト', 'foo', 'bar')).toBe('#fooBar のテスト');
  });

  it('末尾のスラッシュ・ハイフンは境界扱いにはならない(=部分一致回避)', () => {
    // #foo-bar は #foo として一致しない(ハイフンも続字)
    expect(renameInlineTag('#foo-bar', 'foo', 'bar')).toBe('#foo-bar');
  });

  it('コードブロック(```)内は書き換えない', () => {
    const body = ['前 #foo', '```', 'code #foo inside', '```', '後 #foo'].join('\n');
    const want = ['前 #bar', '```', 'code #foo inside', '```', '後 #bar'].join('\n');
    expect(renameInlineTag(body, 'foo', 'bar')).toBe(want);
  });

  it('インラインコード内は書き換えない', () => {
    expect(renameInlineTag('外 #foo `内 #foo` 外 #foo', 'foo', 'bar')).toBe(
      '外 #bar `内 #foo` 外 #bar',
    );
  });

  it('oldName と newName が同じなら何もしない', () => {
    expect(renameInlineTag('#foo', 'foo', 'foo')).toBe('#foo');
  });

  it('空文字が渡されたら何もしない', () => {
    expect(renameInlineTag('#foo', '', 'bar')).toBe('#foo');
    expect(renameInlineTag('#foo', 'foo', '')).toBe('#foo');
  });

  it('Unicode(日本語)タグを扱える', () => {
    expect(renameInlineTag('#日本語 のタグ', '日本語', 'ジャパン')).toBe('#ジャパン のタグ');
  });

  it('階層タグ(スラッシュを含む)を扱える', () => {
    expect(renameInlineTag('本文 #a/b の記述', 'a/b', 'c/d')).toBe('本文 #c/d の記述');
  });
});

describe('renameInlineTag - 追加のエッジケース(#51 Opus L2)', () => {
  it('CRLF 混在でも動作する', () => {
    const body = '#foo は前\r\n本文 #foo です';
    expect(renameInlineTag(body, 'foo', 'bar')).toBe('#bar は前\r\n本文 #bar です');
  });

  it('setext heading の --- を fence と誤検出しない', () => {
    // ハイフン列は setext heading の記法(見出し=)。FENCE_RE は `/~ のみなので影響しない
    const body = '見出し\n---\n#foo あり';
    expect(renameInlineTag(body, 'foo', 'bar')).toBe('見出し\n---\n#bar あり');
  });

  it('##foo(二重ハッシュ)は tag として扱われない', () => {
    // #tag は行頭または空白/開き括弧直後。## の後の foo はマッチしない
    expect(renameInlineTag('##foo test', 'foo', 'bar')).toBe('##foo test');
  });

  it('インラインコード(二重バッククォート内に単一を含む)を跨がず処理', () => {
    // `.*?` パターン(server の stripCode と同じ)で二重バッククォート span を正しく認識
    const body = '外 #foo ``code with ` tick`` 外 #foo';
    expect(renameInlineTag(body, 'foo', 'bar')).toBe('外 #bar ``code with ` tick`` 外 #bar');
  });

  it('未クローズフェンス以降は書き換え対象外', () => {
    const body = '前 #foo\n```\n#foo unclosed\n#foo still in fence';
    const want = '前 #bar\n```\n#foo unclosed\n#foo still in fence';
    expect(renameInlineTag(body, 'foo', 'bar')).toBe(want);
  });
});

describe('removeInlineTag', () => {
  it('#tag を除去し、直前の区切りは残す', () => {
    expect(removeInlineTag('前 #foo 後', 'foo')).toBe('前  後');
  });

  it('行頭の #tag を除去する', () => {
    expect(removeInlineTag('#foo\n本文', 'foo')).toBe('\n本文');
  });

  it('コードブロック内は除去しない', () => {
    const body = ['前 #foo', '```', '#foo', '```', '後 #foo'].join('\n');
    const want = ['前 ', '```', '#foo', '```', '後 '].join('\n');
    expect(removeInlineTag(body, 'foo')).toBe(want);
  });

  it('インラインコード内は除去しない', () => {
    expect(removeInlineTag('外 #foo `内 #foo` 外 #foo', 'foo')).toBe('外  `内 #foo` 外 ');
  });

  it('部分一致で誤爆しない', () => {
    expect(removeInlineTag('#fooBar のテスト', 'foo')).toBe('#fooBar のテスト');
  });

  it('空文字が渡されたら何もしない', () => {
    expect(removeInlineTag('#foo', '')).toBe('#foo');
  });
});
