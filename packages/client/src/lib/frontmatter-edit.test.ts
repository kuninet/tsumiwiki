import { describe, expect, it } from 'vitest';
import {
  buildFrontmatterOps,
  changeRowType,
  createEmptyRow,
  isoToJstLocalInput,
  jstLocalInputToIso,
  rowsFromFrontmatter,
  rowToValue,
  validateRows,
  type PropertyRow,
  type PropertyRowsState,
} from './frontmatter-edit';

describe('frontmatter-edit 純関数群 (#282 F1〜F14)', () => {
  // F1: rowsFromFrontmatter が tags/tag/updated を除き、キー順を保つ。非オブジェクトは空
  it('F1: tags/tag/updated を除外し、キー順を保ち、非オブジェクト入力時は空を返す', () => {
    expect(rowsFromFrontmatter(null)).toEqual({ rows: [], removedKeys: [] });
    expect(rowsFromFrontmatter('string')).toEqual({ rows: [], removedKeys: [] });
    expect(rowsFromFrontmatter([1, 2, 3])).toEqual({ rows: [], removedKeys: [] });

    const fm = {
      title: 'テスト',
      tags: ['a', 'b'],
      tag: 'c',
      price: 1000,
      updated: '2026-10-01T00:00:00+09:00',
      active: true,
    };
    const state = rowsFromFrontmatter(fm);
    expect(state.removedKeys).toEqual([]);
    expect(state.rows.map((r) => r.key)).toEqual(['title', 'price', 'active']);
    expect(state.rows[0].type).toBe('text');
    expect(state.rows[1].type).toBe('number');
    expect(state.rows[2].type).toBe('boolean');
  });

  // F2: kind -> type の対応表を表駆動で全件
  it('F2: 各値の kind に応じた適切な type と初期値が設定される', () => {
    const testCases: [unknown, PropertyRow['type'], string, boolean, string[]][] = [
      [null, 'text', '', false, []],
      ['', 'text', '', false, []],
      [[], 'list', '', false, []],
      [{}, 'object', '', false, []],
      [true, 'boolean', '', true, []],
      [false, 'boolean', '', false, []],
      [42, 'number', '42', false, []],
      ['2024-01-15', 'date', '2024-01-15', false, []],
      ['2026-10-17T01:00:00.000Z', 'datetime', '2026-10-17T10:00', false, []],
      ['https://example.com', 'text', 'https://example.com', false, []],
      ['複数行\nテキスト', 'text', '複数行\nテキスト', false, []],
      [['x', 'y'], 'list', '', false, ['x', 'y']],
      [{ plan: 'basic' }, 'object', '', false, []],
    ];

    for (const [val, expectedType, expectedText, expectedChecked, expectedItems] of testCases) {
      const state = rowsFromFrontmatter({ prop: val });
      const row = state.rows[0];
      expect(row.type).toBe(expectedType);
      expect(row.text).toBe(expectedText);
      expect(row.checked).toBe(expectedChecked);
      expect(row.items).toEqual(expectedItems);
    }
  });

  // F3: datetime の isoToJstLocalInput
  it('F3: isoToJstLocalInput で UTC ISO 文字列が JST の local datetime 文字列に正しく変換される', () => {
    expect(isoToJstLocalInput('2026-10-17T01:00:00.000Z')).toBe('2026-10-17T10:00');
    // 日付の繰り上がり
    expect(isoToJstLocalInput('2026-10-17T20:00:00.000Z')).toBe('2026-10-18T05:00');
  });

  // F4: jstLocalInputToIso
  it('F4: jstLocalInputToIso で local datetime 文字列が JST ISO 文字列に正しく変換される', () => {
    expect(jstLocalInputToIso('2026-10-17T10:00')).toBe('2026-10-17T10:00:00+09:00');
  });

  // F5: 未編集なら buildFrontmatterOps は []
  it('F5: 未編集の場合は buildFrontmatterOps が空配列を返す', () => {
    const fm = {
      text: 'abc',
      num: 123,
      flag: true,
      day: '2024-01-15',
      time: '2026-10-17T01:00:00.000Z',
      arr: ['a', 'b'],
      obj: { nested: 1 },
    };
    const state = rowsFromFrontmatter(fm);
    expect(buildFrontmatterOps(state)).toEqual([]);
  });

  // F6: 値の変更 -> set 1 件、型だけ変更 -> set
  it('F6: 値の変更または型の変更によって適切な set 操作が生成される', () => {
    const state = rowsFromFrontmatter({ title: '旧' });
    state.rows[0].text = '新';
    expect(buildFrontmatterOps(state)).toEqual([
      { op: 'set', key: 'title', value: '新' },
    ]);

    // 型だけ変更 (text -> number で '1')
    const state2 = rowsFromFrontmatter({ count: '1' });
    state2.rows[0] = changeRowType(state2.rows[0], 'number');
    expect(buildFrontmatterOps(state2)).toEqual([
      { op: 'set', key: 'count', value: 1 },
    ]);
  });

  // F7: rename だけ -> rename 1 件、rename + 値変更 -> rename と set(新キー)
  it('F7: rename のみ、および rename + 値変更が期待通りに生成される', () => {
    const state = rowsFromFrontmatter({ price: 1000 });
    state.rows[0].key = 'cost';
    expect(buildFrontmatterOps(state)).toEqual([
      { op: 'rename', from: 'price', to: 'cost' },
    ]);

    const state2 = rowsFromFrontmatter({ price: 1000 });
    state2.rows[0].key = 'cost';
    state2.rows[0].text = '1200';
    expect(buildFrontmatterOps(state2)).toEqual([
      { op: 'rename', from: 'price', to: 'cost' },
      { op: 'set', key: 'cost', value: 1200 },
    ]);
  });

  // F8: 削除 -> delete、削除同名の新規行 -> delete -> set
  it('F8: 削除操作、および既存キー削除＋同名新規追加が delete -> set の順で生成される', () => {
    const state = rowsFromFrontmatter({ price: 1000 });
    state.removedKeys.push('price');
    state.rows = [];
    expect(buildFrontmatterOps(state)).toEqual([
      { op: 'delete', key: 'price' },
    ]);

    const state2 = rowsFromFrontmatter({ price: 1000 });
    state2.removedKeys.push('price');
    const newRow = createEmptyRow(1);
    newRow.key = 'price';
    newRow.text = '2000';
    newRow.type = 'number';
    state2.rows = [newRow];
    expect(buildFrontmatterOps(state2)).toEqual([
      { op: 'delete', key: 'price' },
      { op: 'set', key: 'price', value: 2000 },
    ]);
  });

  // F9: 未入力の新規行は無視、キーだけの新規行は set key null
  it('F9: 未入力の新規行は無視され、キーのみ入力された新規行は set key null となる', () => {
    const state = rowsFromFrontmatter({});
    const emptyRow = createEmptyRow(1);
    const keyOnlyRow = createEmptyRow(2);
    keyOnlyRow.key = 'category';

    state.rows = [emptyRow, keyOnlyRow];
    expect(buildFrontmatterOps(state)).toEqual([
      { op: 'set', key: 'category', value: null },
    ]);
  });

  // F10: validateRows のエラー全種
  it('F10: validateRows が各種バリデーションエラーを正しく検知する', () => {
    const rows: PropertyRow[] = [
      // 0: 空キー(値あり)
      { ...createEmptyRow(1), key: '', text: 'val' },
      // 1: 予約キー tags
      { ...createEmptyRow(2), key: 'tags', text: 'a' },
      // 2: 予約キー tag
      { ...createEmptyRow(3), key: 'tag', text: 'a' },
      // 3: 予約キー updated
      { ...createEmptyRow(4), key: 'updated', text: 'a' },
      // 4: 危険キー __proto__
      { ...createEmptyRow(5), key: '__proto__', text: 'a' },
      // 5: 改行入りキー
      { ...createEmptyRow(6), key: 'a\nb', text: 'a' },
      // 6: 201文字キー
      { ...createEmptyRow(7), key: 'a'.repeat(201), text: 'a' },
      // 7: 重複キー1
      { ...createEmptyRow(8), key: 'dup', text: '1' },
      // 8: 重複キー2 (後の方にエラー)
      { ...createEmptyRow(9), key: 'dup', text: '2' },
      // 9: 不正な数値
      { ...createEmptyRow(10), key: 'num', type: 'number', text: 'abc' },
      // 10: 不正な日付 (閏年でない2月30日)
      { ...createEmptyRow(11), key: 'day', type: 'date', text: '2024-02-30' },
      // 11: 不正な日時
      { ...createEmptyRow(12), key: 'dt', type: 'datetime', text: '2024-01-15T25:00' },
    ];

    const errors = validateRows({ rows, removedKeys: [] });
    expect(errors.get('new:1')).toBe('プロパティ名を入力してください');
    expect(errors.get('new:2')).toBe('「tags」はここでは使えません(タグはタグ欄で編集してください)');
    expect(errors.get('new:3')).toBe('「tag」はここでは使えません(タグはタグ欄で編集してください)');
    expect(errors.get('new:4')).toBe('「updated」は保存時に自動で更新されます');
    expect(errors.get('new:5')).toBe('このプロパティ名は使えません');
    expect(errors.get('new:6')).toBe('プロパティ名に改行や制御文字は使えません');
    expect(errors.get('new:7')).toBe('プロパティ名が長すぎます(200文字まで)');
    expect(errors.has('new:8')).toBe(false);
    expect(errors.get('new:9')).toBe('「dup」は既にあります');
    expect(errors.get('new:10')).toBe('数値を入力してください');
    expect(errors.get('new:11')).toBe('日付の形式が正しくありません');
    expect(errors.get('new:12')).toBe('日時の形式が正しくありません');
  });

  // F11: NFC
  it('F11: キー名は NFC 正規化して重複判定され、濁点分離文字も重複エラーとなる', () => {
    const rows: PropertyRow[] = [
      { ...createEmptyRow(1), key: 'ガ', text: '1' },
      { ...createEmptyRow(2), key: 'カ\u3099', text: '2' }, // カ + 濁点結合文字
    ];
    const errors = validateRows({ rows, removedKeys: [] });
    expect(errors.has('new:1')).toBe(false);
    expect(errors.get('new:2')).toBe('「ガ」は既にあります');
  });

  // F12: changeRowType の変換表を表駆動で全件。object からは変更不可
  it('F12: changeRowType が仕様通りの型・値変換を行い、object 型は変更されない', () => {
    const baseRow: PropertyRow = {
      id: 'r1',
      originalKey: 'k',
      key: 'k',
      type: 'text',
      text: '123',
      checked: false,
      items: [],
      original: null,
      rawValue: null,
    };

    // text -> number
    expect(changeRowType(baseRow, 'number').text).toBe('123');
    // text -> boolean ('true' 以外は false)
    expect(changeRowType({ ...baseRow, text: 'true' }, 'boolean').checked).toBe(true);
    expect(changeRowType({ ...baseRow, text: 'abc' }, 'boolean').checked).toBe(false);
    // text -> date
    expect(changeRowType({ ...baseRow, text: '2024-01-15' }, 'date').text).toBe('2024-01-15');
    expect(changeRowType({ ...baseRow, text: 'invalid' }, 'date').text).toBe('');
    // text -> datetime
    expect(changeRowType({ ...baseRow, text: '2024-01-15T12:00' }, 'datetime').text).toBe(
      '2024-01-15T12:00',
    );
    expect(changeRowType({ ...baseRow, text: '2024-01-15' }, 'datetime').text).toBe(
      '2024-01-15T00:00',
    );
    // text -> list
    expect(changeRowType({ ...baseRow, text: 'hello' }, 'list').items).toEqual(['hello']);
    expect(changeRowType({ ...baseRow, text: '' }, 'list').items).toEqual([]);

    // number/date/datetime -> text
    const dateRow: PropertyRow = { ...baseRow, type: 'date', text: '2024-01-15' };
    expect(changeRowType(dateRow, 'text').text).toBe('2024-01-15');

    // boolean -> text
    const boolRow: PropertyRow = { ...baseRow, type: 'boolean', checked: true };
    expect(changeRowType(boolRow, 'text').text).toBe('true');

    // date -> datetime / datetime -> date
    expect(changeRowType(dateRow, 'datetime').text).toBe('2024-01-15T00:00');
    const dtRow: PropertyRow = { ...baseRow, type: 'datetime', text: '2024-01-15T10:30' };
    expect(changeRowType(dtRow, 'date').text).toBe('2024-01-15');

    // list -> text
    const listRow: PropertyRow = { ...baseRow, type: 'list', items: ['apple', 'banana'] };
    expect(changeRowType(listRow, 'text').text).toBe('apple, banana');

    // 任意 -> list
    expect(changeRowType(boolRow, 'list').items).toEqual(['true']);
    expect(changeRowType(dateRow, 'list').items).toEqual(['2024-01-15']);

    // object からは変更不可
    const objRow: PropertyRow = { ...baseRow, type: 'object', rawValue: { a: 1 } };
    expect(changeRowType(objRow, 'text')).toBe(objRow);
  });

  // F13: list の rowToValue は空配列を [] で返す (null にしない)
  it('F13: list 型の rowToValue は空配列をそのまま [] で返す', () => {
    const row: PropertyRow = {
      ...createEmptyRow(1),
      type: 'list',
      items: [],
    };
    expect(rowToValue(row)).toEqual([]);
  });

  // F14: buildFrontmatterOps の並びが delete -> rename -> set(既存) -> set(新規)
  it('F14: buildFrontmatterOps の操作順序が delete -> rename -> set(既存) -> set(新規) の順になる', () => {
    const state: PropertyRowsState = {
      removedKeys: ['del_key'],
      rows: [
        // 既存行で rename + set
        {
          id: 'fm:old_name',
          originalKey: 'old_name',
          key: 'new_name',
          type: 'text',
          text: 'new_val',
          checked: false,
          items: [],
          original: { type: 'text', text: 'old_val', checked: false, items: [] },
          rawValue: 'old_val',
        },
        // 新規行
        {
          id: 'new:1',
          originalKey: null,
          key: 'created_key',
          type: 'text',
          text: 'val',
          checked: false,
          items: [],
          original: null,
          rawValue: null,
        },
      ],
    };

    const ops = buildFrontmatterOps(state);
    expect(ops).toEqual([
      { op: 'delete', key: 'del_key' },
      { op: 'rename', from: 'old_name', to: 'new_name' },
      { op: 'set', key: 'new_name', value: 'new_val' },
      { op: 'set', key: 'created_key', value: 'val' },
    ]);
  });
});
