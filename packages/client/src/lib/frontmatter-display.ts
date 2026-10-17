// フロントマター（プロパティ）の分類・表示用純関数群(#281)

export type PropertyKind =
  | 'null' // null / undefined
  | 'empty' // '' / [] / {}
  | 'boolean'
  | 'number'
  | 'date' // 日付のみ（YYYY-MM-DD）
  | 'datetime' // 日時
  | 'url' // http(s) のみ
  | 'text' // その他の文字列（複数行含む）
  | 'list' // primitive だけの配列
  | 'object'; // プレーンオブジェクト、または object を含む配列

export interface PropertyEntry {
  key: string;
  value: unknown;
  kind: PropertyKind;
}

// パネルに出さないキー。tags / tag は TagChipEditor が唯一の UI
export const HIDDEN_PROPERTY_KEYS: readonly string[] = ['tags', 'tag'];

// プレーンオブジェクトの判定
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.prototype.toString.call(v) === '[object Object]'
  );
}

// 実在するカレンダー日付（グレゴリオ暦）かどうかの判定
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_UTC_ZERO_RE = /^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.000)?Z$/;
const DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// プロパティ値の型判定（上から順に評価）
export function classifyPropertyValue(v: unknown): PropertyKind {
  // 1. null / undefined
  if (v === null || v === undefined) {
    return 'null';
  }

  // 2. boolean
  if (typeof v === 'boolean') {
    return 'boolean';
  }

  // 3. number（NaN / Infinity は text 扱い）
  if (typeof v === 'number') {
    return Number.isFinite(v) ? 'number' : 'text';
  }

  // 文字列の判定
  if (typeof v === 'string') {
    // 4. 空白のみの文字列
    if (v.trim() === '') {
      return 'empty';
    }

    // 5. UTC 0時のISO文字列（YAML非クォート日付相当）
    const matchUtcZero = DATE_UTC_ZERO_RE.exec(v);
    if (matchUtcZero) {
      const year = parseInt(matchUtcZero[1], 10);
      const month = parseInt(matchUtcZero[2], 10);
      const day = parseInt(matchUtcZero[3], 10);
      if (isValidCalendarDate(year, month, day)) {
        return 'date';
      }
    }

    // 6. YYYY-MM-DD 形式の日付文字列
    const matchDateOnly = DATE_ONLY_RE.exec(v);
    if (matchDateOnly) {
      const year = parseInt(matchDateOnly[1], 10);
      const month = parseInt(matchDateOnly[2], 10);
      const day = parseInt(matchDateOnly[3], 10);
      if (isValidCalendarDate(year, month, day)) {
        return 'date';
      }
    }

    // 7. 日時文字列
    const matchDatetime = DATETIME_RE.exec(v);
    if (matchDatetime) {
      const year = parseInt(matchDatetime[1], 10);
      const month = parseInt(matchDatetime[2], 10);
      const day = parseInt(matchDatetime[3], 10);
      const hour = parseInt(matchDatetime[4], 10);
      const minute = parseInt(matchDatetime[5], 10);
      const second = matchDatetime[6] ? parseInt(matchDatetime[6], 10) : 0;
      if (
        isValidCalendarDate(year, month, day) &&
        hour >= 0 &&
        hour <= 23 &&
        minute >= 0 &&
        minute <= 59 &&
        second >= 0 &&
        second <= 59 &&
        !Number.isNaN(Date.parse(v))
      ) {
        return 'datetime';
      }
    }

    // 8. http(s) URL
    if (/^https?:\/\/\S+$/i.test(v)) {
      try {
        new URL(v);
        return 'url';
      } catch {
        // パース失敗時は text
      }
    }

    // 9. その他の文字列
    return 'text';
  }

  // 配列の判定
  if (Array.isArray(v)) {
    // 10. 空配列
    if (v.length === 0) {
      return 'empty';
    }
    // 11. プリミティブ（string/number/boolean）のみの配列
    const isPrimitiveList = v.every((item) => {
      if (typeof item === 'string' || typeof item === 'boolean') return true;
      if (typeof item === 'number') return Number.isFinite(item);
      return false;
    });
    if (isPrimitiveList) {
      return 'list';
    }
    // 12. オブジェクト・配列・nullを含む配列
    return 'object';
  }

  // プレーンオブジェクトの判定
  if (isPlainObject(v)) {
    // 13. 空オブジェクト
    if (Object.keys(v).length === 0) {
      return 'empty';
    }
    // 14. オブジェクト
    return 'object';
  }

  // 15. それ以外
  return 'text';
}

// 表示対象のプロパティエントリ一覧を取得する
export function visiblePropertyEntries(frontmatter: unknown): PropertyEntry[] {
  if (!isPlainObject(frontmatter)) {
    return [];
  }

  const entries: PropertyEntry[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (HIDDEN_PROPERTY_KEYS.includes(key)) {
      continue;
    }
    entries.push({
      key,
      value,
      kind: classifyPropertyValue(value),
    });
  }

  return entries;
}

// 日付・日時のフォーマット整形
export function formatDateValue(iso: string, kind: 'date' | 'datetime'): string {
  if (kind === 'date') {
    return iso.slice(0, 10);
  }

  const d = new Date(iso);
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(d);
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${getPart('year')}/${getPart('month')}/${getPart('day')} ${getPart('hour')}:${getPart('minute')}`;
}

// オブジェクト値の JSON 直列化整形
export function formatJsonValue(v: unknown): string {
  return JSON.stringify(v);
}
