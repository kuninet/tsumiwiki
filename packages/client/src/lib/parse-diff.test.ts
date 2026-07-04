import { describe, expect, it } from 'vitest';
import { parseDiff } from './parse-diff';

describe('parseDiff', () => {
  it('空のdiffは空配列を返す', () => {
    expect(parseDiff('')).toEqual([]);
  });

  it('メタ行・ハンク・追加・削除・文脈行を種別分けする', () => {
    const diff = [
      'diff --git a/a.md b/a.md',
      'index abc123..def456 100644',
      '--- a/a.md',
      '+++ b/a.md',
      '@@ -1,3 +1,3 @@',
      ' 文脈行',
      '-削除された行',
      '+追加された行',
      '',
    ].join('\n');

    expect(parseDiff(diff)).toEqual([
      { type: 'meta', text: 'diff --git a/a.md b/a.md' },
      { type: 'meta', text: 'index abc123..def456 100644' },
      { type: 'meta', text: '--- a/a.md' },
      { type: 'meta', text: '+++ b/a.md' },
      { type: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { type: 'context', text: ' 文脈行' },
      { type: 'del', text: '-削除された行' },
      { type: 'add', text: '+追加された行' },
    ]);
  });

  it('末尾の改行以外の空行は文脈行として保持する', () => {
    const diff = '@@ -1,2 +1,2 @@\n context\n\n';
    expect(parseDiff(diff)).toEqual([
      { type: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { type: 'context', text: ' context' },
      { type: 'context', text: '' },
    ]);
  });
});

describe('レビュー指摘の回帰テスト', () => {
  it('frontmatter区切り(---)の削除行はdelとして分類される', async () => {
    const { parseDiff } = await import('./parse-diff');
    const diff = [
      '--- a/文書.md',
      '+++ b/文書.md',
      '@@ -1,4 +1,2 @@',
      '----',
      '-tags: [旧]',
      '----',
      ' 本文',
    ].join('\n');
    const lines = parseDiff(diff);
    expect(lines[0].type).toBe('meta'); // --- a/文書.md
    expect(lines[1].type).toBe('meta'); // +++ b/文書.md
    expect(lines[3].type).toBe('del'); // -「---」
    expect(lines[4].type).toBe('del');
    expect(lines[5].type).toBe('del');
    expect(lines[6].type).toBe('context');
  });

  it('追加された+++風の行もハンク内ではaddになる', async () => {
    const { parseDiff } = await import('./parse-diff');
    const lines = parseDiff('@@ -1 +1 @@\n+++強調++');
    expect(lines[1].type).toBe('add');
  });

  it('複数ハンクでも種別が維持される', async () => {
    const { parseDiff } = await import('./parse-diff');
    const diff = '@@ -1 +1 @@\n-a\n+b\n@@ -10 +10 @@\n-c\n+d';
    const types = parseDiff(diff).map((l) => l.type);
    expect(types).toEqual(['hunk', 'del', 'add', 'hunk', 'del', 'add']);
  });
});
