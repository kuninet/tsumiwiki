import { describe, expect, it } from 'vitest';
import { parseDocMeta } from './markdown-meta.js';

// メタデータ抽出のエッジケース(計画者レビューで指摘された頑健性の検証)

describe('parseDocMeta: コード除外の頑健性', () => {
  it('4連バッククォートのフェンス内のタグを除外する', () => {
    const md = '````\n#フェンス内タグ\n````\n\n#外のタグ';
    expect(parseDocMeta(md).inlineTags).toEqual(['外のタグ']);
  });

  it('フェンス内の3連バッククォート行では閉じない(長い方が優先)', () => {
    const md = '````\n```\n#まだフェンス内\n````\n#外のタグ';
    expect(parseDocMeta(md).inlineTags).toEqual(['外のタグ']);
  });

  it('未クローズのフェンス以降は文書末尾まで除外する', () => {
    const md = '#前のタグ\n\n```js\n#閉じられていないフェンス内';
    expect(parseDocMeta(md).inlineTags).toEqual(['前のタグ']);
  });

  it('ダブルバッククォートのインラインコード内を除外する', () => {
    const md = '本文 ``#コード内 `入れ子` `` と #本物タグ';
    expect(parseDocMeta(md).inlineTags).toEqual(['本物タグ']);
  });

  it('チルダフェンス(~~~)にも対応する', () => {
    const md = '~~~\n#チルダ内\n~~~\n#外側';
    expect(parseDocMeta(md).inlineTags).toEqual(['外側']);
  });
});

describe('parseDocMeta: フロントマターの寛容パース', () => {
  it('壊れたYAMLでもフェンス部分を除いた本文を返す', () => {
    const md = '---\ntags: [unclosed\n---\n本文のテキスト #救済タグ';
    const meta = parseDocMeta(md);
    expect(meta.frontmatterTags).toEqual([]);
    expect(meta.inlineTags).toEqual(['救済タグ']);
    expect(meta.body).not.toContain('unclosed');
    expect(meta.body).toContain('本文のテキスト');
  });

  it('タグをNFCに正規化する(NFD混入対策)', () => {
    // 「ブログ」のNFD表現(濁点分解)をフロントマターとインラインの両方に置く
    const nfd = 'ブログ';
    const md = `---\ntags: [${nfd}]\n---\n本文 #${nfd}`;
    const meta = parseDocMeta(md);
    expect(meta.frontmatterTags).toEqual(['ブログ'.normalize('NFC')]);
    expect(meta.inlineTags).toEqual(['ブログ'.normalize('NFC')]);
  });
});
