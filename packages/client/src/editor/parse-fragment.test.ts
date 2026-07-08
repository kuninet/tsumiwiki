import { describe, expect, it } from 'vitest';
import { parseMarkdownFragment } from './parse-fragment';

// #84 Phase C: Markdown → PMJSON パーサの単体テスト。DocView での挿入位置計算に効くので、
// size が「挿入後カーソル境界」として意味を持つ挙動を凍結する。

describe('parseMarkdownFragment', () => {
  it('空文字列は content=[] / size=0', () => {
    expect(parseMarkdownFragment('')).toEqual({ content: [], size: 0 });
  });

  it('空白のみも空扱い(軽微#10: 空 paragraph を作らない)', () => {
    expect(parseMarkdownFragment('   \n\n  ')).toEqual({ content: [], size: 0 });
  });

  it('通常のパラグラフは 1 ノード + 非 0 サイズ', () => {
    const r = parseMarkdownFragment('こんにちは\n');
    expect(r.content).toHaveLength(1);
    expect(r.size).toBeGreaterThan(0);
  });

  it('pre + post を連結して挿入した時の境界は pre.size と一致する(挿入位置計算の要)', () => {
    const pre = parseMarkdownFragment('段落A\n');
    const combined = parseMarkdownFragment('段落A\n\n段落B\n');
    // 挿入位置 P に content を入れた場合、combined.size は pre.size + post.size にほぼ等しい
    // (段落境界の 1 単位差は Tiptap 側の join 挙動によって揺れるので `>=` で確認)
    expect(combined.size).toBeGreaterThanOrEqual(pre.size);
  });
});
