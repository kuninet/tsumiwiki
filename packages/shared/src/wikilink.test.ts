import { describe, expect, it } from 'vitest';
import type { DocSummary } from './index.js';
import {
  buildWikilinkResolver,
  parseWikilinkTarget,
  resolveWikilink,
} from './wikilink.js';

function doc(path: string, title: string): DocSummary {
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return { path, title, folder, updatedAt: '2026-01-01T00:00:00Z' };
}

describe('parseWikilinkTarget', () => {
  it('単純なページ名を正しくパースする', () => {
    const meta = parseWikilinkTarget('Page');
    expect(meta).toEqual({
      raw: 'Page',
      target: 'Page',
      targetKey: 'page',
      anchor: '',
      isInternal: false,
    });
  });

  it('見出し付きリンクを分離する', () => {
    const meta = parseWikilinkTarget('Page#見出し');
    expect(meta).toEqual({
      raw: 'Page#見出し',
      target: 'Page',
      targetKey: 'page',
      anchor: '見出し',
      isInternal: false,
    });
  });

  it('ブロックID付きリンクを分離する', () => {
    const meta = parseWikilinkTarget('Page#^block-123');
    expect(meta).toEqual({
      raw: 'Page#^block-123',
      target: 'Page',
      targetKey: 'page',
      anchor: '^block-123',
      isInternal: false,
    });
  });

  it('別名付きリンクから別名を除去してパースする', () => {
    const meta = parseWikilinkTarget('Page#見出し|別名');
    expect(meta).toEqual({
      raw: 'Page#見出し|別名',
      target: 'Page',
      targetKey: 'page',
      anchor: '見出し',
      isInternal: false,
    });
  });

  it('自文書内見出しリンクを判定する', () => {
    const meta = parseWikilinkTarget('#自文書見出し');
    expect(meta).toEqual({
      raw: '#自文書見出し',
      target: '',
      targetKey: '',
      anchor: '自文書見出し',
      isInternal: true,
    });
  });

  it('自文書内ブロックIDリンクを判定する', () => {
    const meta = parseWikilinkTarget('#^internal-block');
    expect(meta).toEqual({
      raw: '#^internal-block',
      target: '',
      targetKey: '',
      anchor: '^internal-block',
      isInternal: true,
    });
  });

  it('先頭の./や/および\\の区切り文字を正規化する', () => {
    const meta = parseWikilinkTarget('./folder\\sub/doc#sec');
    expect(meta.target).toBe('folder/sub/doc');
    expect(meta.targetKey).toBe('folder/sub/doc');
    expect(meta.anchor).toBe('sec');
  });

  it('.md拡張子を末尾から除去する', () => {
    const meta = parseWikilinkTarget('folder/doc.md#sec');
    expect(meta.target).toBe('folder/doc');
    expect(meta.targetKey).toBe('folder/doc');
    expect(meta.anchor).toBe('sec');
  });

  it('NFD文字列をNFCに正規化する', () => {
    const nfd = 'フォルダ'.normalize('NFD');
    const meta = parseWikilinkTarget(`${nfd}/ページ`);
    expect(meta.target).toBe('フォルダ/ページ'.normalize('NFC'));
  });
});

describe('resolveWikilink', () => {
  it('パスの完全一致(拡張子省略形)を優先して解決する', () => {
    const docs = [doc('フォルダ/ページ.md', '別タイトル'), doc('他のフォルダ/ページ.md', 'ページ')];
    expect(resolveWikilink('フォルダ/ページ', docs)).toBe('フォルダ/ページ.md');
  });

  it('パス完全一致がなければタイトル一致で解決する', () => {
    const docs = [doc('a/議事録.md', '議事録')];
    expect(resolveWikilink('議事録', docs)).toBe('a/議事録.md');
  });

  it('folder/title形式の末尾一致で解決する', () => {
    const docs = [doc('親/フォルダ/ページ.md', 'ページ')];
    expect(resolveWikilink('フォルダ/ページ', docs)).toBe('親/フォルダ/ページ.md');
  });

  it('アンカー付きリンクでも文書パスに解決する', () => {
    const docs = [doc('仕様書.md', '仕様書'), doc('sub/API.md', 'API')];
    expect(resolveWikilink('仕様書#概要', docs)).toBe('仕様書.md');
    expect(resolveWikilink('sub/API#^req-1', docs)).toBe('sub/API.md');
  });

  it('大文字小文字の違いを許容して解決する (readme -> README.md)', () => {
    const docs = [doc('README.md', 'README')];
    expect(resolveWikilink('readme', docs)).toBe('README.md');
  });

  it('大文字小文字完全一致が存在する場合は優先される', () => {
    const docs = [doc('README.md', 'README'), doc('readme.md', 'readme')];
    expect(resolveWikilink('readme', docs)).toBe('readme.md');
    expect(resolveWikilink('README', docs)).toBe('README.md');
  });

  it('同名候補が複数あるとき、pathのコード単位昇順で決定する', () => {
    const docs = [doc('z/議事録.md', '議事録'), doc('a/議事録.md', '議事録'), doc('m/議事録.md', '議事録')];
    expect(resolveWikilink('議事録', docs)).toBe('a/議事録.md');
  });

  it('大文字小文字混在の複数候補がある場合、コード単位の昇順で安定して決定する', () => {
    // UTF-16コード単位比較では 'B' (0x42) < 'a' (0x61)
    const docs = [doc('a/memo.md', 'memo'), doc('B/memo.md', 'memo')];
    expect(resolveWikilink('memo', docs)).toBe('B/memo.md');

    // 'A' (0x41) < 'b' (0x62)
    const docs2 = [doc('b/memo.md', 'memo'), doc('A/memo.md', 'memo')];
    expect(resolveWikilink('memo', docs2)).toBe('A/memo.md');
  });

  it('末尾一致で複数候補がある場合もコード単位の昇順で決定する', () => {
    const docs = [doc('z/dir/page.md', 'page'), doc('a/dir/page.md', 'page')];
    expect(resolveWikilink('dir/page', docs)).toBe('a/dir/page.md');
  });

  it('自文書内アンカーのみの場合はnullを返す', () => {
    const docs = [doc('a.md', 'a')];
    expect(resolveWikilink('#見出し', docs)).toBeNull();
    expect(resolveWikilink('#^abc', docs)).toBeNull();
  });

  it('一致する文書がなければnullを返す', () => {
    const docs = [doc('a.md', 'a')];
    expect(resolveWikilink('存在しない', docs)).toBeNull();
  });

  it('空文字や空白のみはnullを返す', () => {
    const docs = [doc('a.md', 'a')];
    expect(resolveWikilink('', docs)).toBeNull();
    expect(resolveWikilink('   ', docs)).toBeNull();
  });

  it('buildWikilinkResolverとresolveWikilinkで同一の結果を返す', () => {
    const docs = [
      doc('docs/guide.md', 'Guide'),
      doc('README.md', 'README'),
      doc('a/note.md', 'Note'),
      doc('b/note.md', 'Note'),
    ];
    const resolver = buildWikilinkResolver(docs);

    expect(resolver('guide#sec')).toBe(resolveWikilink('guide#sec', docs));
    expect(resolver('readme')).toBe(resolveWikilink('readme', docs));
    expect(resolver('note')).toBe(resolveWikilink('note', docs));
    expect(resolver('missing')).toBe(resolveWikilink('missing', docs));
  });
});
