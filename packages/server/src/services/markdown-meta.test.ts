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

describe('extractDocLinks / parseDocMeta: リンク抽出', () => {
  it('基本リンクを抽出する', () => {
    const md = 'これは [[Wikiページ]] へのリンクです。';
    const meta = parseDocMeta(md);
    expect(meta.links).toHaveLength(1);
    expect(meta.links[0]).toMatchObject({
      seq: 0,
      targetRaw: 'Wikiページ',
      targetNorm: 'Wikiページ',
      targetKey: 'wikiページ',
      anchor: null,
      alias: null,
      line: 1,
    });
    expect(meta.links[0].context).toContain('これは [[Wikiページ]] へのリンクです。');
  });

  it('aliasとanchorを正しく分離する', () => {
    const md = '参照: [[設計書#概要|サマリ]]';
    const meta = parseDocMeta(md);
    expect(meta.links).toHaveLength(1);
    expect(meta.links[0]).toMatchObject({
      seq: 0,
      targetRaw: '設計書#概要',
      targetNorm: '設計書',
      targetKey: '設計書',
      anchor: '概要',
      alias: 'サマリ',
      line: 1,
    });
  });

  it('ブロックID付きリンクを抽出する', () => {
    const md = 'ブロック参照 [[仕様#^block-1]]';
    const meta = parseDocMeta(md);
    expect(meta.links[0]).toMatchObject({
      targetNorm: '仕様',
      anchor: '^block-1',
    });
  });

  it('自文書内見出しリンク([[#見出し]])は索引から除外する', () => {
    const md = '目次: [[#第1章]] と [[#^b1]]、そして [[別文書#第1章]]';
    const meta = parseDocMeta(md);
    expect(meta.links).toHaveLength(1);
    expect(meta.links[0].targetNorm).toBe('別文書');
  });

  it('画像埋め込み(![[...]])はリンク索引から除外する', () => {
    const md = '画像: ![[diagram.png]] と リンク: [[ドキュメント]]';
    const meta = parseDocMeta(md);
    expect(meta.links).toHaveLength(1);
    expect(meta.links[0].targetNorm).toBe('ドキュメント');
  });

  it('コードブロックおよびインラインコード内の[[...]]を除外する', () => {
    const md = [
      '# タイトル',
      '```markdown',
      '[[コード内リンク1]]',
      '```',
      '本文 `[[インラインコードリンク]]` と [[本物リンク]]',
      '~~~',
      '[[チルダコード内]]',
      '~~~',
    ].join('\n');
    const meta = parseDocMeta(md);
    expect(meta.links).toHaveLength(1);
    expect(meta.links[0].targetNorm).toBe('本物リンク');
  });

  it('複数リンクのseqと行番号(line)を正しく保持する', () => {
    const md = [
      '1行目 [[リンク1]]',
      '2行目 テキスト',
      '3行目 [[リンク2]] と [[リンク3]]',
    ].join('\n');
    const meta = parseDocMeta(md);
    expect(meta.links).toHaveLength(3);
    expect(meta.links[0]).toMatchObject({ seq: 0, targetNorm: 'リンク1', line: 1 });
    expect(meta.links[1]).toMatchObject({ seq: 1, targetNorm: 'リンク2', line: 3 });
    expect(meta.links[2]).toMatchObject({ seq: 2, targetNorm: 'リンク3', line: 3 });
  });
});
