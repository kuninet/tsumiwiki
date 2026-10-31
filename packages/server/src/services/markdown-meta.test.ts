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

describe('parseDocMeta: フロントマターのプロパティ抽出', () => {
  const props = (fm: string) => parseDocMeta(`---\n${fm}\n---\n本文`).properties;

  it('string / number / boolean を文字列表現と型で返す', () => {
    expect(props('status: todo\npriority: 1\nratio: 1.5\ndone: false')).toEqual([
      { key: 'status', seq: 0, value: 'todo', type: 'string' },
      { key: 'priority', seq: 0, value: '1', type: 'number' },
      { key: 'ratio', seq: 0, value: '1.5', type: 'number' },
      { key: 'done', seq: 0, value: 'false', type: 'boolean' },
    ]);
  });

  it('日付(時刻なし)は YYYY-MM-DD、日時は ISO 文字列で type date', () => {
    expect(props('due: 2026-10-31')).toEqual([
      { key: 'due', seq: 0, value: '2026-10-31', type: 'date' },
    ]);
    expect(props('at: 2026-10-31T10:30:00+09:00')).toEqual([
      { key: 'at', seq: 0, value: '2026-10-31T01:30:00.000Z', type: 'date' },
    ]);
  });

  it('引用符つきの日付形式の文字列は string のまま', () => {
    expect(props('due: "2026-10-31"')).toEqual([
      { key: 'due', seq: 0, value: '2026-10-31', type: 'string' },
    ]);
  });

  it('null は value null・type null', () => {
    expect(props('empty:\nnothing: null')).toEqual([
      { key: 'empty', seq: 0, value: null, type: 'null' },
      { key: 'nothing', seq: 0, value: null, type: 'null' },
    ]);
  });

  it('配列は要素ごとに seq を振り、空配列は行を作らない', () => {
    expect(props('projects: [A, B]\nnone: []')).toEqual([
      { key: 'projects', seq: 0, value: 'A', type: 'string' },
      { key: 'projects', seq: 1, value: 'B', type: 'string' },
    ]);
  });

  it('配列の要素ごとに型が決まり、入れ子の配列・object は type object', () => {
    expect(props('mix: [1, x, [a, b], {k: v}]')).toEqual([
      { key: 'mix', seq: 0, value: '1', type: 'number' },
      { key: 'mix', seq: 1, value: 'x', type: 'string' },
      { key: 'mix', seq: 2, value: null, type: 'object' },
      { key: 'mix', seq: 3, value: null, type: 'object' },
    ]);
  });

  it('object は value null・type object', () => {
    expect(props('meta:\n  a: 1')).toEqual([
      { key: 'meta', seq: 0, value: null, type: 'object' },
    ]);
  });

  it('tags / tag は除外する', () => {
    expect(props('tags: [a, b]\ntag: c\nstatus: todo')).toEqual([
      { key: 'status', seq: 0, value: 'todo', type: 'string' },
    ]);
  });

  it('キーと文字列値を NFC に正規化する', () => {
    const nfd = 'ブログ'.normalize('NFD');
    expect(props(`${nfd}: ${nfd}`)).toEqual([
      { key: 'ブログ', seq: 0, value: 'ブログ', type: 'string' },
    ]);
  });

  it('NFC 正規化で同じになるキーが複数あっても片方だけ採用する(主キー衝突の防止)', () => {
    const nfc = 'ブログ'.normalize('NFC');
    const nfd = 'ブログ'.normalize('NFD');
    const result = props(`${nfc}: a\n${nfd}: b`);
    expect(result).toEqual([{ key: nfc, seq: 0, value: 'a', type: 'string' }]);
  });

  it('空文字キーは入れない', () => {
    expect(props('"": x\nk: v')).toEqual([{ key: 'k', seq: 0, value: 'v', type: 'string' }]);
  });

  it('フロントマターが無ければ空配列', () => {
    expect(parseDocMeta('本文のみ').properties).toEqual([]);
  });

  it('壊れたフロントマターは空配列', () => {
    expect(parseDocMeta('---\nstatus: [unclosed\n---\n本文').properties).toEqual([]);
  });
});
