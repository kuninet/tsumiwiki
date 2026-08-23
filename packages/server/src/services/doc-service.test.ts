import { describe, expect, it } from 'vitest';
import { extractLinkTargets } from './doc-service.js';

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
