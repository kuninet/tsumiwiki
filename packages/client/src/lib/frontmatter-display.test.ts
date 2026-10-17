import { describe, expect, it } from 'vitest';
import {
  classifyPropertyValue,
  formatDateValue,
  formatJsonValue,
  isPlainObject,
  visiblePropertyEntries,
} from './frontmatter-display';

describe('frontmatter-display 純関数テスト', () => {
  it('U1: 非オブジェクトや空値に対して visiblePropertyEntries は空配列を返す', () => {
    expect(visiblePropertyEntries({})).toEqual([]);
    expect(visiblePropertyEntries(null)).toEqual([]);
    expect(visiblePropertyEntries(undefined)).toEqual([]);
    expect(visiblePropertyEntries(['a', 'b'])).toEqual([]);
    expect(visiblePropertyEntries('foo')).toEqual([]);
    expect(visiblePropertyEntries(42)).toEqual([]);
  });

  it('U2: tags および tag キーは除外され、他のキーのみが返る', () => {
    const entries = visiblePropertyEntries({ tags: ['a'], tag: 'b', title: 'x' });
    expect(entries).toEqual([
      { key: 'title', value: 'x', kind: 'text' },
    ]);
  });

  it('U3: オブジェクトのキー順序が保持される', () => {
    const entries = visiblePropertyEntries({ b: 1, a: 2, c: 3 });
    expect(entries.map((e) => e.key)).toEqual(['b', 'a', 'c']);
  });

  it('U4: 全15パターンの型判定が正しく行われる（表駆動）', () => {
    const cases: Array<{ input: unknown; expected: string }> = [
      // 1: null / undefined
      { input: null, expected: 'null' },
      { input: undefined, expected: 'null' },
      // 2: boolean
      { input: true, expected: 'boolean' },
      { input: false, expected: 'boolean' },
      // 3: number (falsy 0含む)
      { input: 0, expected: 'number' },
      { input: 980, expected: 'number' },
      { input: -1.5, expected: 'number' },
      { input: Number.NaN, expected: 'text' },
      { input: Number.POSITIVE_INFINITY, expected: 'text' },
      // 4: 空文字列 (whitespace含む)
      { input: '', expected: 'empty' },
      { input: '   ', expected: 'empty' },
      // 5: UTC 0時のISO (date)
      { input: '2024-01-15T00:00:00.000Z', expected: 'date' },
      { input: '2024-01-15T00:00:00Z', expected: 'date' },
      // 6: YYYY-MM-DD (date)
      { input: '2024-01-15', expected: 'date' },
      // 7: datetime
      { input: '2026-10-17T10:00:00+09:00', expected: 'datetime' },
      { input: '2026-10-17T01:00:00.000Z', expected: 'datetime' },
      { input: '2026-10-17T01:00Z', expected: 'datetime' },
      // 8: url (http / https のみ)
      { input: 'https://example.com/test', expected: 'url' },
      { input: 'http://localhost:3000', expected: 'url' },
      // 9: その他の文字列（不正日付、他スキーム、wikilink風等）
      { input: '2024-13-45', expected: 'text' },
      { input: '2024-02-31', expected: 'text' }, // 存在しないカレンダー日付
      { input: 'javascript:alert(1)', expected: 'text' },
      { input: 'file:///path/to/file', expected: 'text' },
      { input: 'mailto:user@example.com', expected: 'text' },
      { input: '[[DocLink]]', expected: 'text' },
      { input: '通常テキスト', expected: 'text' },
      // 10: 空配列
      { input: [], expected: 'empty' },
      // 11: プリミティブのみの配列 (list)
      { input: ['x', 2, true], expected: 'list' },
      { input: ['単一要素'], expected: 'list' },
      // 12: オブジェクト・配列・nullを含む配列 (object)
      { input: [{ a: 1 }], expected: 'object' },
      { input: [null], expected: 'object' },
      { input: [['ネスト']], expected: 'object' },
      // 13: 空オブジェクト
      { input: {}, expected: 'empty' },
      // 14: オブジェクト
      { input: { key: 'value' }, expected: 'object' },
    ];

    for (const { input, expected } of cases) {
      expect(
        classifyPropertyValue(input),
        `input: ${JSON.stringify(input)}`,
      ).toBe(expected);
    }
  });

  it('U5: formatDateValue は date の場合に YYYY-MM-DD（TZ変換なし）を返す', () => {
    expect(formatDateValue('2024-01-15T00:00:00.000Z', 'date')).toBe('2024-01-15');
    expect(formatDateValue('2024-01-15', 'date')).toBe('2024-01-15');
  });

  it('U6: formatDateValue は datetime の場合に JST で YYYY/MM/DD HH:mm を返す', () => {
    // 2026-10-17T01:00:00.000Z は JST で 10:00
    expect(formatDateValue('2026-10-17T01:00:00.000Z', 'datetime')).toBe(
      '2026/10/17 10:00',
    );
    expect(formatDateValue('2026-10-17T10:00:00+09:00', 'datetime')).toBe(
      '2026/10/17 10:00',
    );
  });

  it('U7: isPlainObject の判定', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('str')).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
  });

  it('U8: formatJsonValue でオブジェクトが正しくJSON直列化される', () => {
    expect(formatJsonValue({ k: 'v', n: { d: 1 } })).toBe('{"k":"v","n":{"d":1}}');
    expect(formatJsonValue([{ a: 1 }])).toBe('[{"a":1}]');
  });
});
