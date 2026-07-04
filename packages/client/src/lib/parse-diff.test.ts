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
