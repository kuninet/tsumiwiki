import type { FrontmatterOp, FrontmatterValue } from '@tsumiwiki/shared';
import { classifyPropertyValue, isPlainObject } from './frontmatter-display';

export type EditablePropertyType = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'list';

// 編集中の 1 行。値は入力欄の文字列表現で持つ(数値の入力途中 "1." などを壊さないため)
export interface PropertyRow {
  id: string; // React key。読み込み時は `fm:${key}`、追加時は `new:${連番}`
  originalKey: string | null; // 読み込み時のキー。新規行は null
  key: string; // 現在のキー(入力中の値)
  type: EditablePropertyType | 'object'; // object は値の編集不可(キー名変更・削除のみ)
  text: string; // text/number/date/datetime の入力値
  checked: boolean; // boolean の値
  items: string[]; // list の値
  original: { type: PropertyRow['type']; text: string; checked: boolean; items: string[] } | null;
  rawValue: unknown; // object 型の表示用・未編集判定用の元の値
}

export interface PropertyRowsState {
  rows: PropertyRow[];
  removedKeys: string[]; // 削除した既存キー(originalKey)
}

// UI のプロパティ編集で触れないキー(#282)
export const RESERVED_PROPERTY_KEYS: readonly string[] = ['tags', 'tag', 'updated'];

// グレゴリオ暦のカレンダー実在日判定
function isValidDateParts(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

// YYYY-MM-DD 文字列の実在日判定
function isValidDateString(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  return isValidDateParts(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
}

// YYYY-MM-DDTHH:mm 文字列の実在日時判定
function isValidDatetimeString(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m) return false;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  return (
    isValidDateParts(year, month, day) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59
  );
}

// ISO8601日時から JST の datetime-local 用文字列 ("YYYY-MM-DDTHH:mm") に変換
export function isoToJstLocalInput(iso: string): string {
  const d = new Date(iso);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 16);
}

// datetime-local 用文字列 ("YYYY-MM-DDTHH:mm") から JST の ISO8601 文字列に変換
export function jstLocalInputToIso(local: string): string {
  return `${local}:00+09:00`;
}

// フロントマターオブジェクトから編集用行状態を生成
export function rowsFromFrontmatter(frontmatter: unknown): PropertyRowsState {
  if (!isPlainObject(frontmatter)) {
    return { rows: [], removedKeys: [] };
  }

  const rows: PropertyRow[] = [];
  for (const [key, v] of Object.entries(frontmatter)) {
    if (RESERVED_PROPERTY_KEYS.includes(key)) {
      continue;
    }
    const kind = classifyPropertyValue(v);
    let type: PropertyRow['type'] = 'text';
    let text = '';
    let checked = false;
    let items: string[] = [];

    switch (kind) {
      case 'null':
        type = 'text';
        text = '';
        break;
      case 'empty':
        if (typeof v === 'string') {
          type = 'text';
          text = '';
        } else if (Array.isArray(v)) {
          type = 'list';
          items = [];
        } else {
          type = 'object';
        }
        break;
      case 'boolean':
        type = 'boolean';
        checked = Boolean(v);
        break;
      case 'number':
        type = 'number';
        text = String(v);
        break;
      case 'date':
        type = 'date';
        text = String(v).slice(0, 10);
        break;
      case 'datetime':
        type = 'datetime';
        text = isoToJstLocalInput(String(v));
        break;
      case 'url':
      case 'text':
        type = 'text';
        text = String(v);
        break;
      case 'list':
        type = 'list';
        items = Array.isArray(v) ? v.map(String) : [];
        break;
      case 'object':
        type = 'object';
        break;
    }

    rows.push({
      id: `fm:${key}`,
      originalKey: key,
      key,
      type,
      text,
      checked,
      items,
      original: { type, text, checked, items: [...items] },
      rawValue: v,
    });
  }

  return { rows, removedKeys: [] };
}

// 次の新規行連番を計算
export function getNextSeq(rows: PropertyRow[]): number {
  let maxSeq = 0;
  for (const r of rows) {
    if (r.id.startsWith('new:')) {
      const num = parseInt(r.id.slice(4), 10);
      if (!Number.isNaN(num) && num > maxSeq) {
        maxSeq = num;
      }
    }
  }
  return maxSeq + 1;
}

// 新規の空行を生成
export function createEmptyRow(seq: number): PropertyRow {
  return {
    id: `new:${seq}`,
    originalKey: null,
    key: '',
    type: 'text',
    text: '',
    checked: false,
    items: [],
    original: null,
    rawValue: null,
  };
}

// 行の型を変更し、値を可能な限り引き継ぐ
export function changeRowType(row: PropertyRow, next: EditablePropertyType): PropertyRow {
  if (row.type === 'object' || row.type === next) {
    return row;
  }

  let text = '';
  let checked = false;
  let items: string[] = [];

  switch (next) {
    case 'text':
      if (row.type === 'boolean') {
        text = String(row.checked);
      } else if (row.type === 'list') {
        text = row.items.join(', ');
      } else {
        text = row.text;
      }
      break;

    case 'number':
      if (row.type === 'text') {
        const trimmed = row.text.trim();
        const n = Number(trimmed);
        text = trimmed !== '' && Number.isFinite(n) ? String(n) : '';
      }
      break;

    case 'boolean':
      if (row.type === 'text') {
        checked = row.text.trim().toLowerCase() === 'true';
      }
      break;

    case 'date':
      if (row.type === 'datetime') {
        text = row.text.slice(0, 10);
      } else if (row.type === 'text') {
        text = isValidDateString(row.text) ? row.text : '';
      }
      break;

    case 'datetime':
      if (row.type === 'date') {
        text = row.text ? `${row.text}T00:00` : '';
      } else if (row.type === 'text') {
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(row.text) && isValidDatetimeString(row.text)) {
          text = row.text;
        } else if (isValidDateString(row.text)) {
          text = `${row.text}T00:00`;
        }
      }
      break;

    case 'list':
      if (row.type === 'text') {
        const trimmed = row.text.trim();
        items = trimmed === '' ? [] : [trimmed];
      } else if (row.type === 'boolean') {
        items = [String(row.checked)];
      } else {
        items = row.text ? [row.text] : [];
      }
      break;
  }

  return {
    ...row,
    type: next,
    text,
    checked,
    items,
  };
}

// 行ごとのバリデーションを行い、エラーのマップ (row.id -> エラーメッセージ) を返す
export function validateRows(state: PropertyRowsState): Map<string, string> {
  const errors = new Map<string, string>();
  const seenKeys = new Set<string>();

  for (const row of state.rows) {
    const normKey = row.key.normalize('NFC').trim();

    // 未入力の新規行（キー空かつ値空）はエラーにしない
    const isNew = row.originalKey === null;
    const isKeyEmpty = normKey === '';
    const isValueEmpty =
      (row.type === 'text' || row.type === 'number' || row.type === 'date' || row.type === 'datetime')
        ? row.text === ''
        : row.type === 'boolean'
          ? !row.checked
          : row.type === 'list'
            ? row.items.length === 0
            : true;

    if (isNew && isKeyEmpty && isValueEmpty) {
      continue;
    }

    if (isKeyEmpty) {
      errors.set(row.id, 'プロパティ名を入力してください');
      continue;
    }

    if (normKey === 'updated') {
      errors.set(row.id, '「updated」は保存時に自動で更新されます');
      continue;
    }

    if (normKey === 'tags' || normKey === 'tag') {
      errors.set(row.id, `「${normKey}」はここでは使えません(タグはタグ欄で編集してください)`);
      continue;
    }

    if (normKey === '__proto__' || normKey === 'constructor' || normKey === 'prototype') {
      errors.set(row.id, 'このプロパティ名は使えません');
      continue;
    }

    if (/[\u0000-\u001f\u007f]/.test(normKey)) {
      errors.set(row.id, 'プロパティ名に改行や制御文字は使えません');
      continue;
    }

    if (normKey.length > 200) {
      errors.set(row.id, 'プロパティ名が長すぎます(200文字まで)');
      continue;
    }

    if (seenKeys.has(normKey)) {
      errors.set(row.id, `「${normKey}」は既にあります`);
      continue;
    }
    seenKeys.add(normKey);

    // 値の型別検証
    if (row.type === 'number') {
      if (row.text.trim() !== '' && !Number.isFinite(Number(row.text))) {
        errors.set(row.id, '数値を入力してください');
        continue;
      }
    } else if (row.type === 'date') {
      if (row.text !== '' && !isValidDateString(row.text)) {
        errors.set(row.id, '日付の形式が正しくありません');
        continue;
      }
    } else if (row.type === 'datetime') {
      if (row.text !== '' && !isValidDatetimeString(row.text)) {
        errors.set(row.id, '日時の形式が正しくありません');
        continue;
      }
    }
  }

  return errors;
}

// 編集行から保存用のフロントマター値を算出
export function rowToValue(row: PropertyRow): FrontmatterValue {
  switch (row.type) {
    case 'text':
      return row.text === '' ? null : row.text;
    case 'number':
      return row.text.trim() === '' ? null : Number(row.text);
    case 'boolean':
      return row.checked;
    case 'date':
      return row.text === '' ? null : row.text;
    case 'datetime':
      return row.text === '' ? null : jstLocalInputToIso(row.text);
    case 'list':
      return row.items;
    case 'object':
      return null;
  }
}

// 編集状態から保存用のフロントマター操作列 (FrontmatterOp[]) を生成
export function buildFrontmatterOps(state: PropertyRowsState): FrontmatterOp[] {
  const ops: FrontmatterOp[] = [];

  // 1. 削除操作
  for (const key of state.removedKeys) {
    ops.push({ op: 'delete', key });
  }

  // 2. リネーム操作
  for (const row of state.rows) {
    if (row.originalKey !== null) {
      const normKey = row.key.normalize('NFC').trim();
      if (normKey !== '' && normKey !== row.originalKey) {
        ops.push({ op: 'rename', from: row.originalKey, to: normKey });
      }
    }
  }

  // 3. 既存行の値の更新操作
  for (const row of state.rows) {
    if (row.originalKey !== null) {
      if (row.type === 'object') continue;
      const normKey = row.key.normalize('NFC').trim();
      if (normKey === '') continue;

      let changed = false;
      if (row.original) {
        if (row.type !== row.original.type) {
          changed = true;
        } else if (row.type === 'boolean') {
          changed = row.checked !== row.original.checked;
        } else if (row.type === 'list') {
          changed = JSON.stringify(row.items) !== JSON.stringify(row.original.items);
        } else {
          changed = row.text !== row.original.text;
        }
      }
      if (changed) {
        ops.push({ op: 'set', key: normKey, value: rowToValue(row) });
      }
    }
  }

  // 4. 新規行の追加操作
  for (const row of state.rows) {
    if (row.originalKey === null) {
      const normKey = row.key.normalize('NFC').trim();
      const isValueEmpty =
        (row.type === 'text' || row.type === 'number' || row.type === 'date' || row.type === 'datetime')
          ? row.text === ''
          : row.type === 'boolean'
            ? !row.checked
            : row.type === 'list'
              ? row.items.length === 0
              : true;
      if (normKey === '' && isValueEmpty) {
        continue;
      }
      if (normKey !== '') {
        ops.push({ op: 'set', key: normKey, value: rowToValue(row) });
      }
    }
  }

  return ops;
}

// フォーム表示時のプロパティ件数を数える
export function visibleRowCount(state: PropertyRowsState): number {
  return state.rows.length;
}
