import type { DocSummary } from '@tsumiwiki/shared';
import { describe, expect, it } from 'vitest';
import { resolveWikilink } from './resolve-wikilink';

function doc(path: string, title: string): DocSummary {
  return { path, title, folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', updatedAt: 't' };
}

describe('resolveWikilink', () => {
  it('パスの完全一致(拡張子省略形)を優先して解決する', () => {
    const docs = [doc('フォルダ/ページ.md', '別タイトル'), doc('フォルダ/ページ.md', '別タイトル')];
    expect(resolveWikilink('フォルダ/ページ', docs)).toBe('フォルダ/ページ.md');
  });

  it('パス完全一致がなければタイトル一致で解決する', () => {
    const docs = [doc('a/議事録.md', '議事録')];
    expect(resolveWikilink('議事録', docs)).toBe('a/議事録.md');
  });

  it('タイトルが複数一致する場合は最初の一致を採用する', () => {
    const docs = [doc('a/議事録.md', '議事録'), doc('b/議事録.md', '議事録')];
    expect(resolveWikilink('議事録', docs)).toBe('a/議事録.md');
  });

  it('folder/title形式の末尾一致で解決する(ネストしたフォルダ配下)', () => {
    const docs = [doc('親/フォルダ/ページ.md', 'ページ')];
    expect(resolveWikilink('フォルダ/ページ', docs)).toBe('親/フォルダ/ページ.md');
  });

  it('一致する文書がなければnullを返す', () => {
    const docs = [doc('a.md', 'a')];
    expect(resolveWikilink('存在しない', docs)).toBeNull();
  });

  it('空文字はnullを返す', () => {
    expect(resolveWikilink('  ', [doc('a.md', 'a')])).toBeNull();
  });
});
