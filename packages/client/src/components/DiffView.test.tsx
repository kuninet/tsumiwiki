import { describe, expect, it } from 'vitest';
import type { DiffLine } from '../lib/parse-diff';
import { groupDiffLines } from './DiffView';

describe('groupDiffLines', () => {
  it('meta行は表示に含めない', () => {
    const lines: DiffLine[] = [
      { type: 'meta', text: '--- a/foo.md' },
      { type: 'meta', text: '+++ b/foo.md' },
      { type: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { type: 'context', text: ' 変わらない' },
      { type: 'add', text: '+追加' },
    ];
    const groups = groupDiffLines(lines);
    // meta / hunk / context / add → hunk先頭では divider を出さない
    expect(groups).toEqual([
      { kind: 'context', texts: ['変わらない'] },
      { kind: 'add', texts: ['追加'] },
    ]);
  });

  it('同種の行は1グループにまとめる', () => {
    const lines: DiffLine[] = [
      { type: 'hunk', text: '@@ -1 +1,2 @@' },
      { type: 'add', text: '+一行目' },
      { type: 'add', text: '+二行目' },
      { type: 'del', text: '-削除1' },
      { type: 'del', text: '-削除2' },
    ];
    const groups = groupDiffLines(lines);
    expect(groups).toEqual([
      { kind: 'add', texts: ['一行目', '二行目'] },
      { kind: 'del', texts: ['削除1', '削除2'] },
    ]);
  });

  it('ハンク境界に divider を差し込む(先頭では出さない)', () => {
    const lines: DiffLine[] = [
      { type: 'hunk', text: '@@ -1 +1 @@' },
      { type: 'add', text: '+A' },
      { type: 'hunk', text: '@@ -5 +5 @@' },
      { type: 'add', text: '+B' },
    ];
    const groups = groupDiffLines(lines);
    expect(groups).toEqual([
      { kind: 'add', texts: ['A'] },
      { kind: 'divider' },
      { kind: 'add', texts: ['B'] },
    ]);
  });
});
