import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import {
  applyFrontmatterOps,
  extractLeadingFrontmatter,
  extractLinkTargets,
  FrontmatterUpdateError,
  frontmatterStatusOf,
  validateFrontmatterPatch,
} from './doc-service.js';

// extractLinkTargets(issue #199)の単体テスト。DocService.renameAttachment /
// findAttachmentReferencesが参照検出に使う純関数

describe('extractLinkTargets', () => {
  it('Obsidian埋め込み(![[target]])を抽出する', () => {
    expect(extractLinkTargets('見出し\n![[image.png]]\n本文')).toEqual(['image.png']);
  });

  it('wikilink([[target]])を抽出する', () => {
    expect(extractLinkTargets('[[image.png]]について')).toEqual(['image.png']);
  });

  it('Markdown画像(![alt](target))を抽出する', () => {
    expect(extractLinkTargets('![スクショ](sub/image.png)')).toEqual(['sub/image.png']);
  });

  it('Markdownリンク([text](target))を抽出する', () => {
    expect(extractLinkTargets('[こちら](sub/image.png)を参照')).toEqual(['sub/image.png']);
  });

  it('エイリアス(|alias)は落として本体のみ抽出する', () => {
    expect(extractLinkTargets('![[image.png|300]]')).toEqual(['image.png']);
  });

  it('アンカー(#anchor)は落として本体のみ抽出する', () => {
    expect(extractLinkTargets('[[image.png#見出し]]')).toEqual(['image.png']);
  });

  it('title("...")は落として本体のみ抽出する', () => {
    expect(extractLinkTargets('![alt](image.png "タイトル")')).toEqual(['image.png']);
  });

  it('http(s)/data/mailto/fileスキームは除外する', () => {
    const body = [
      '![](https://example.com/a.png)',
      '[link](http://example.com/b.png)',
      '![](data:image/png;base64,AAAA)',
      '[mail](mailto:a@example.com)',
      '[local](file:///etc/passwd)',
    ].join('\n');
    expect(extractLinkTargets(body)).toEqual([]);
  });

  it('複数行・複数種の記法から重複なく抽出する', () => {
    const body = [
      '![[a.png]]',
      '[[a.png|表示名]]',
      '![alt](sub/b.png)',
      '[text](sub/b.png "t")',
      '[[c.png#anchor]]',
    ].join('\n');
    expect(extractLinkTargets(body)).toEqual(['a.png', 'c.png', 'sub/b.png']);
  });

  it('targetの?/#以降を落とす(Markdownリンク)', () => {
    expect(extractLinkTargets('![alt](image.png?v=2#frag)')).toEqual(['image.png']);
  });

  it('ヒットなしは空配列', () => {
    expect(extractLinkTargets('ただの本文です')).toEqual([]);
  });

  it('前後に空白があるtargetはtrimして抽出する(軽微8)', () => {
    expect(extractLinkTargets('![[ image.png ]]')).toEqual(['image.png']);
  });

  it('【中2】フェンス(```)内の参照は抽出しない', () => {
    const body = ['```', '![[in-fence.png]]', '```', '![[out-fence.png]]'].join('\n');
    expect(extractLinkTargets(body)).toEqual(['out-fence.png']);
  });

  it('【中2】フェンス(~~~)内の参照も抽出しない', () => {
    const body = ['~~~', '![[in-fence.png]]', '~~~', '![[out-fence.png]]'].join('\n');
    expect(extractLinkTargets(body)).toEqual(['out-fence.png']);
  });

  it('【中2】インラインコード(`...`)内の参照は抽出しない', () => {
    const body = '`![[in-code.png]]` と ![[out-code.png]]';
    expect(extractLinkTargets(body)).toEqual(['out-code.png']);
  });

  it('【中2】インデントのみのコードブロックは対象外(通常どおり抽出される)', () => {
    const body = '    ![[indented.png]]';
    expect(extractLinkTargets(body)).toEqual(['indented.png']);
  });
});

describe('validateFrontmatterPatch', () => {
  it('undefined またはパッチなしは undefined を返す', () => {
    expect(validateFrontmatterPatch(undefined)).toBeUndefined();
  });

  it('正常なパッチはキーを NFC 正規化して返す', () => {
    const result = validateFrontmatterPatch({
      料金単価: 1000,
      自動更新: true,
      プラン: 'pro',
    });
    expect(result).toEqual({
      料金単価: 1000,
      自動更新: true,
      プラン: 'pro',
    });
  });

  it('予約キー tags を含む場合は FrontmatterUpdateError を throw する', () => {
    expect(() => validateFrontmatterPatch({ tags: ['a'] })).toThrow(FrontmatterUpdateError);
  });

  it('予約キー updated を含む場合は FrontmatterUpdateError を throw する', () => {
    expect(() => validateFrontmatterPatch({ updated: '2026-01-01' })).toThrow(FrontmatterUpdateError);
  });

  it('危険キー __proto__ を含む場合は FrontmatterUpdateError を throw する', () => {
    const patch = JSON.parse('{"__proto__": {"admin": true}}');
    expect(() => validateFrontmatterPatch(patch)).toThrow(FrontmatterUpdateError);
  });

  it('危険キー constructor を含む場合は FrontmatterUpdateError を throw する', () => {
    expect(() => validateFrontmatterPatch({ constructor: 'bad' })).toThrow(FrontmatterUpdateError);
  });

  it('危険キー prototype を含む場合は FrontmatterUpdateError を throw する', () => {
    expect(() => validateFrontmatterPatch({ prototype: 'bad' })).toThrow(FrontmatterUpdateError);
  });

  it('空キーまたは空白のみのキーは FrontmatterUpdateError を throw する', () => {
    expect(() => validateFrontmatterPatch({ '': 'val' })).toThrow(FrontmatterUpdateError);
    expect(() => validateFrontmatterPatch({ '   ': 'val' })).toThrow(FrontmatterUpdateError);
  });
});

describe('extractLeadingFrontmatter', () => {
  it('フロントマター無しの本文はそのまま返し、frontmatter は undefined', () => {
    const result = extractLeadingFrontmatter('# 見出し\n\n本文です');
    expect(result).toEqual({ body: '# 見出し\n\n本文です' });
  });

  it('有効なフロントマター付き本文からプロパティとタグを抽出しヘッダーを除去する', () => {
    const body = [
      '---',
      'title: テスト',
      'tags:',
      '  - a',
      '  - b',
      'updated: 2026-01-01',
      '料金単価: 1000',
      '---',
      '',
      '本文です',
    ].join('\n');
    const result = extractLeadingFrontmatter(body);
    expect(result.body).toBe('\n本文です');
    expect(result.frontmatter).toEqual({
      title: 'テスト',
      料金単価: 1000,
    });
    expect(result.tags).toEqual(['a', 'b']);
  });

  it('水平線で始まるだけの本文は誤抽出せずそのまま返す', () => {
    const body = '---\n\nただの文章\n\n---';
    const result = extractLeadingFrontmatter(body);
    expect(result).toEqual({ body });
  });

  it('構文エラーのフロントマターは本文としてそのまま返す', () => {
    const body = '---\n[壊れたYAML\n---\n\n本文';
    const result = extractLeadingFrontmatter(body);
    expect(result).toEqual({ body });
  });

  it('空値キー(aliases: など)は値 null として抽出される', () => {
    const body = [
      '---',
      'title: テスト',
      'aliases:',
      '備考:',
      '---',
      '',
      '本文です',
    ].join('\n');
    const result = extractLeadingFrontmatter(body);
    expect(result.body).toBe('\n本文です');
    expect(result.frontmatter).toEqual({
      title: 'テスト',
      aliases: null,
      備考: null,
    });
  });
});

describe('applyFrontmatterOps & frontmatterStatusOf (#282 P1〜P16)', () => {
  // P1: 値の置換でコメントが残る
  it('P1: 既存スカラー値の置換で行末コメントと前後のコメント行が保持される', () => {
    const src = 'title: a # 行末\nprice: 980 # 価格\n# 次\ncreated: 2024-01-15\n';
    const doc = parseDocument(src);
    applyFrontmatterOps(doc, [{ op: 'set', key: 'price', value: 1200 }]);
    expect(doc.toString()).toBe('title: a # 行末\nprice: 1200 # 価格\n# 次\ncreated: 2024-01-15\n');
  });

  // P2: rename で位置とコメントが残る
  it('P2: rename でキーの位置・直前コメント・行末コメントが保持される', () => {
    const src = 'title: a # 行末\nprice: 980 # 価格\n# 次\ncreated: 2024-01-15\n';
    const doc = parseDocument(src);
    applyFrontmatterOps(doc, [{ op: 'rename', from: 'created', to: 'made' }]);
    expect(doc.toString()).toBe('title: a # 行末\nprice: 980 # 価格\n# 次\nmade: 2024-01-15\n');
  });

  // P3: 入れ替え
  it('P3: 2つのキー名を同時に入れ替えることができる', () => {
    const src = 'c: 2\nn: 5\n';
    const doc = parseDocument(src);
    applyFrontmatterOps(doc, [
      { op: 'rename', from: 'c', to: 'n' },
      { op: 'rename', from: 'n', to: 'c' },
    ]);
    expect(doc.toString()).toBe('n: 2\nc: 5\n');
  });

  // P4: rename 先が既存
  it('P4: rename 先が既存キーと重複する場合は FrontmatterUpdateError をスローし変更しない', () => {
    const src = 'a: 1\nb: 2\n';
    const doc = parseDocument(src);
    expect(() => applyFrontmatterOps(doc, [{ op: 'rename', from: 'a', to: 'b' }])).toThrow(
      FrontmatterUpdateError,
    );
    expect(doc.toString()).toBe('a: 1\nb: 2\n');
  });

  // P5: rename 元が無い
  it('P5: rename 元が存在しないキーの場合は何も変更せず無視する', () => {
    const src = 'a: 1\n';
    const doc = parseDocument(src);
    applyFrontmatterOps(doc, [{ op: 'rename', from: 'zz', to: 'yy' }]);
    expect(doc.toString()).toBe('a: 1\n');
  });

  // P6: delete が無いキー
  it('P6: 存在しないキーの delete は何も変更せず無視する', () => {
    const src = 'a: 1\n';
    const doc = parseDocument(src);
    applyFrontmatterOps(doc, [{ op: 'delete', key: 'zz' }]);
    expect(doc.toString()).toBe('a: 1\n');
  });

  // P7: 先頭キーの削除で見出しコメントが残る
  it('P7: 先頭キーを削除したとき、ファイル先頭見出しコメントが次のキーに残る', () => {
    const src = '# 先頭\na: 1\n# b の説明\nb: 2\n';
    const doc = parseDocument(src);
    applyFrontmatterOps(doc, [{ op: 'delete', key: 'a' }]);
    expect(doc.toString()).toBe('# 先頭\n# b の説明\nb: 2\n');
  });

  // P7b: 途中キーの削除
  it('P7b: 途中キーの削除時、そのキー直前の説明コメントは一緒に削除される', () => {
    const src = 'x: 0\n# a の説明\na: 1 # 行末\nb: 2\n';
    const doc = parseDocument(src);
    applyFrontmatterOps(doc, [{ op: 'delete', key: 'a' }]);
    expect(doc.toString()).toBe('x: 0\nb: 2\n');
  });

  // P8: 予約キー
  it('P8: 予約キー(tags, tag, updated)への操作は FrontmatterUpdateError をスローする', () => {
    const doc = parseDocument('a: 1\n');
    expect(() => applyFrontmatterOps(doc, [{ op: 'set', key: 'tags', value: ['x'] }])).toThrow(
      FrontmatterUpdateError,
    );
    expect(() => applyFrontmatterOps(doc, [{ op: 'set', key: 'tag', value: 'x' }])).toThrow(
      FrontmatterUpdateError,
    );
    expect(() => applyFrontmatterOps(doc, [{ op: 'set', key: 'updated', value: '2026-01-01' }])).toThrow(
      FrontmatterUpdateError,
    );
    expect(() => applyFrontmatterOps(doc, [{ op: 'rename', from: 'a', to: 'updated' }])).toThrow(
      FrontmatterUpdateError,
    );
    expect(() => applyFrontmatterOps(doc, [{ op: 'delete', key: 'tags' }])).toThrow(
      FrontmatterUpdateError,
    );
  });

  // P9: 危険キー・制御文字・空キー
  it('P9: 危険キー・改行制御文字・空キーは FrontmatterUpdateError をスローする', () => {
    const doc = parseDocument('a: 1\n');
    expect(() => applyFrontmatterOps(doc, [{ op: 'set', key: '__proto__', value: 'bad' }])).toThrow(
      FrontmatterUpdateError,
    );
    expect(() => applyFrontmatterOps(doc, [{ op: 'set', key: 'a\nb', value: 'val' }])).toThrow(
      FrontmatterUpdateError,
    );
    expect(() => applyFrontmatterOps(doc, [{ op: 'set', key: '   ', value: 'val' }])).toThrow(
      FrontmatterUpdateError,
    );
  });

  // P10: NFC
  it('P10: キー名は NFC 正規化され、濁点分離文字も合成文字として1つに扱われる', () => {
    const doc = parseDocument('ガ: 1\n');
    // 'カ\u3099' は濁点分離の「ガ」
    applyFrontmatterOps(doc, [{ op: 'set', key: 'カ\u3099', value: 2 }]);
    expect(doc.toString()).toBe('ガ: 2\n');
  });

  // P11: アンカー
  it('P11: アンカー参照のある値の変更・削除は拒否され、エイリアス側は値で置換される', () => {
    const src = 'x: &anc foo\ny: *anc\n';
    const doc1 = parseDocument(src);
    expect(() => applyFrontmatterOps(doc1, [{ op: 'set', key: 'x', value: 'bar' }])).toThrow(
      FrontmatterUpdateError,
    );
    expect(() => applyFrontmatterOps(doc1, [{ op: 'delete', key: 'x' }])).toThrow(
      FrontmatterUpdateError,
    );

    const doc2 = parseDocument(src);
    applyFrontmatterOps(doc2, [{ op: 'set', key: 'y', value: 'bar' }]);
    expect(doc2.toString()).toBe('x: &anc foo\ny: bar\n');
  });

  // P12: flow 列の維持
  it('P12: 既存の flow 列の更新時は flow 表記とコメントが維持される', () => {
    const src = 'f: [a, b] # c\n';
    const doc = parseDocument(src);
    applyFrontmatterOps(doc, [{ op: 'set', key: 'f', value: ['a', 'b', 'c'] }]);
    expect(doc.toString()).toBe('f: [ a, b, c ] # c\n');
  });

  // P13: 型の書き出し
  it('P13: 各型の値が期待される YAML 表現で出力される', () => {
    const doc = parseDocument('');
    applyFrontmatterOps(doc, [
      { op: 'set', key: 's', value: '123' },
      { op: 'set', key: 'b', value: 'true' },
      { op: 'set', key: 'd', value: '2024-01-15' },
      { op: 'set', key: 'e', value: null },
      { op: 'set', key: 'm', value: 'a\nb' },
    ]);
    const out = doc.toString();
    expect(out).toContain('s: "123"');
    expect(out).toContain('b: "true"');
    expect(out).toContain('d: 2024-01-15');
    expect(out).toContain('e: null');
    expect(out).toContain('m: |-\n  a\n  b');
  });

  // P14: 空 FM
  it('P14: contents が null の空 FM に対して set, rename, delete が安全に動作する', () => {
    const doc = parseDocument('');
    applyFrontmatterOps(doc, [
      { op: 'set', key: 'k', value: 'v' },
      { op: 'rename', from: 'a', to: 'b' },
      { op: 'delete', key: 'c' },
    ]);
    expect(doc.toString()).toBe('k: v\n');
  });

  // P15: frontmatterStatusOf
  it('P15: frontmatterStatusOf が FM なし、空ブロック、正常、不正形式を正しく判別する', () => {
    expect(frontmatterStatusOf('ただの本文\n')).toBe('none');
    expect(frontmatterStatusOf('---\n---\n本文\n')).toBe('none');
    expect(frontmatterStatusOf('---\n\n---\n本文\n')).toBe('ok');
    expect(frontmatterStatusOf('---\na: 1\n---\n本文\n')).toBe('ok');
    expect(frontmatterStatusOf('---\n: x\n---\n本文\n')).toBe('invalid');
    expect(frontmatterStatusOf('---\n- a\n---\n本文\n')).toBe('invalid');
    expect(frontmatterStatusOf('---\na: 1\n本文\n')).toBe('invalid');
  });

  // P16: 文字列でないキー
  it('P16: 数値や真偽値のキーに対しても重複を作らず set, rename, delete が行える', () => {
    const src = '123: a\ntrue: b\n';
    const doc = parseDocument(src);
    applyFrontmatterOps(doc, [
      { op: 'set', key: '123', value: 'x' },
      { op: 'rename', from: 'true', to: 'flag' },
    ]);
    expect(doc.toString()).toBe('123: x\nflag: b\n');

    const doc2 = parseDocument(src);
    applyFrontmatterOps(doc2, [{ op: 'delete', key: '123' }]);
    expect(doc2.toString()).toBe('true: b\n');
  });
});
