import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  changeRowType,
  createEmptyRow,
  getNextSeq,
  type EditablePropertyType,
  type PropertyRow,
  type PropertyRowsState,
} from '../lib/frontmatter-edit';
import { classifyPropertyValue } from '../lib/frontmatter-display';
import { PropertyValue } from './PropertyValue';

export interface PropertyEditorProps {
  state: PropertyRowsState;
  errors: Map<string, string>;
  onChange: (next: PropertyRowsState) => void;
  readonlyUpdated?: { value: unknown };
}

// プロパティ値の型ごとの入力フィールド
interface PropertyValueInputProps {
  row: PropertyRow;
  error?: string;
  onChange: (updatedRow: PropertyRow) => void;
}

function PropertyValueInput({ row, error, onChange }: PropertyValueInputProps) {
  const [newItemText, setNewItemText] = useState('');

  switch (row.type) {
    case 'text': {
      const isMultiLine = (row.text ?? '').includes('\n');
      if (isMultiLine) {
        const lineCount = Math.max(2, (row.text ?? '').split('\n').length);
        return (
          <textarea
            aria-label={`${row.key} の値`}
            value={row.text ?? ''}
            rows={lineCount}
            aria-invalid={error ? 'true' : undefined}
            onChange={(e) => onChange({ ...row, text: e.target.value })}
            className="w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-xs text-ink-soft focus:outline-none focus:ring-1 focus:ring-line"
          />
        );
      }
      return (
        <input
          type="text"
          aria-label={`${row.key} の値`}
          value={row.text ?? ''}
          aria-invalid={error ? 'true' : undefined}
          onChange={(e) => onChange({ ...row, text: e.target.value })}
          className="w-full rounded border border-line bg-canvas px-2 py-1 text-xs text-ink-soft focus:outline-none focus:ring-1 focus:ring-line"
        />
      );
    }

    case 'number': {
      return (
        <input
          type="text"
          inputMode="decimal"
          aria-label={`${row.key} の値`}
          value={row.text ?? ''}
          aria-invalid={error ? 'true' : undefined}
          onChange={(e) => onChange({ ...row, text: e.target.value })}
          className="w-full rounded border border-line bg-canvas px-2 py-1 text-xs text-ink-soft focus:outline-none focus:ring-1 focus:ring-line"
        />
      );
    }

    case 'boolean': {
      return (
        <label className="flex items-center gap-1.5 py-1 text-xs text-ink-soft">
          <input
            type="checkbox"
            aria-label={`${row.key} の値`}
            checked={row.checked}
            aria-invalid={error ? 'true' : undefined}
            onChange={(e) => onChange({ ...row, checked: e.target.checked })}
            className="rounded border-line"
          />
          <span>{row.checked ? 'true' : 'false'}</span>
        </label>
      );
    }

    case 'date': {
      return (
        <input
          type="date"
          aria-label={`${row.key} の値`}
          value={row.text ?? ''}
          aria-invalid={error ? 'true' : undefined}
          onChange={(e) => onChange({ ...row, text: e.target.value })}
          className="w-full rounded border border-line bg-canvas px-2 py-1 text-xs text-ink-soft focus:outline-none focus:ring-1 focus:ring-line"
        />
      );
    }

    case 'datetime': {
      return (
        <input
          type="datetime-local"
          aria-label={`${row.key} の値`}
          value={row.text ?? ''}
          aria-invalid={error ? 'true' : undefined}
          onChange={(e) => onChange({ ...row, text: e.target.value })}
          className="w-full rounded border border-line bg-canvas px-2 py-1 text-xs text-ink-soft focus:outline-none focus:ring-1 focus:ring-line"
        />
      );
    }

    case 'list': {
      const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          if (e.nativeEvent.isComposing) return;
          e.preventDefault();
          const trimmed = newItemText.trim();
          if (trimmed) {
            onChange({ ...row, items: [...row.items, trimmed] });
            setNewItemText('');
          }
        }
      };

      const handleRemoveItem = (indexToRemove: number) => {
        const nextItems = row.items.filter((_, idx) => idx !== indexToRemove);
        onChange({ ...row, items: nextItems });
      };

      return (
        <div className="flex w-full flex-col gap-1.5 py-0.5">
          {row.items.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {row.items.map((item, index) => (
                <li
                  key={`${index}-${item}`}
                  className="flex items-center gap-1 rounded bg-line/40 px-1.5 py-0.5 text-xs text-ink-soft"
                >
                  <span>{item}</span>
                  <button
                    type="button"
                    aria-label={`${item} を削除`}
                    onClick={() => handleRemoveItem(index)}
                    className="text-ink-faint hover:text-danger"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            type="text"
            aria-label={`${row.key} に項目を追加`}
            value={newItemText}
            onChange={(e) => setNewItemText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="項目を入力して Enter"
            className="w-full rounded border border-line bg-canvas px-2 py-1 text-xs text-ink-soft focus:outline-none focus:ring-1 focus:ring-line"
          />
        </div>
      );
    }

    case 'object': {
      return (
        <div className="flex flex-col gap-1 py-1">
          <code className="break-all rounded bg-line/30 px-1.5 py-0.5 font-mono text-xs text-ink-soft">
            {JSON.stringify(row.rawValue)}
          </code>
          <span className="text-xs text-ink-faint">入れ子の値はここでは編集できません</span>
        </div>
      );
    }
  }
}

// プロパティ編集フォーム
export function PropertyEditor({
  state,
  errors,
  onChange,
  readonlyUpdated,
}: PropertyEditorProps) {
  const pendingFocusIdRef = useRef<string | null>(null);
  const knownRowIdsRef = useRef<Set<string>>(new Set());

  // 新規追加行へのフォーカス制御（新規追加直後のみフォーカスし、既存行の入力時は奪わない）
  useEffect(() => {
    // 新しく追加された新規行（originalKey === null かつ以前存在しなかった行）を探す
    const newAddedRow = state.rows.find(
      (r) => r.originalKey === null && !knownRowIdsRef.current.has(r.id),
    );
    const targetId = pendingFocusIdRef.current ?? newAddedRow?.id ?? null;

    if (targetId) {
      const input = document.querySelector<HTMLInputElement>(
        `input[data-row-key-id="${targetId}"]`,
      );
      if (input) {
        input.focus();
      }
      pendingFocusIdRef.current = null;
    }

    knownRowIdsRef.current = new Set(state.rows.map((r) => r.id));
  }, [state.rows]);

  const handleKeyChange = (row: PropertyRow, newKey: string) => {
    const nextRows = state.rows.map((r) => (r.id === row.id ? { ...r, key: newKey } : r));
    onChange({ ...state, rows: nextRows });
  };

  const handleTypeChange = (row: PropertyRow, newType: EditablePropertyType) => {
    const nextRow = changeRowType(row, newType);
    const nextRows = state.rows.map((r) => (r.id === row.id ? nextRow : r));
    onChange({ ...state, rows: nextRows });
  };

  const handleValueChange = (updatedRow: PropertyRow) => {
    const nextRows = state.rows.map((r) => (r.id === updatedRow.id ? updatedRow : r));
    onChange({ ...state, rows: nextRows });
  };

  const handleDeleteRow = (row: PropertyRow) => {
    const nextRows = state.rows.filter((r) => r.id !== row.id);
    const nextRemovedKeys = row.originalKey
      ? Array.from(new Set([...state.removedKeys, row.originalKey]))
      : state.removedKeys;
    onChange({ ...state, rows: nextRows, removedKeys: nextRemovedKeys });
  };

  const handleAddRow = () => {
    const seq = getNextSeq(state.rows);
    const newRow = createEmptyRow(seq);
    pendingFocusIdRef.current = newRow.id;
    onChange({
      ...state,
      rows: [...state.rows, newRow],
    });
  };

  return (
    <div
      data-testid="properties-editor"
      role="group"
      aria-label="プロパティの編集"
      className="flex flex-col gap-2 px-3 pt-1 pb-2"
    >
      <div className="flex flex-col gap-2">
        {state.rows.map((row) => {
          const error = errors.get(row.id);
          const errorId = `error-${row.id}`;

          return (
            <div
              key={row.id}
              data-testid="property-row"
              data-key={row.key}
              className="flex flex-col gap-1 border-b border-line/40 pb-2 last:border-b-0"
            >
              <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(6rem,10rem)_auto_1fr_auto]">
                {/* キー入力 */}
                <input
                  type="text"
                  aria-label="プロパティ名"
                  data-row-key-id={row.id}
                  value={row.key}
                  aria-invalid={error ? 'true' : undefined}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(e) => handleKeyChange(row, e.target.value)}
                  className="rounded border border-line bg-canvas px-2 py-1 font-mono text-xs text-ink-soft focus:outline-none focus:ring-1 focus:ring-line"
                />

                {/* 型選択 */}
                <select
                  aria-label={`${row.key} の型`}
                  value={row.type}
                  disabled={row.type === 'object'}
                  onChange={(e) =>
                    handleTypeChange(row, e.target.value as EditablePropertyType)
                  }
                  className="rounded border border-line bg-canvas px-2 py-1 text-xs text-ink-soft focus:outline-none focus:ring-1 focus:ring-line disabled:opacity-50"
                >
                  <option value="text">テキスト</option>
                  <option value="number">数値</option>
                  <option value="boolean">真偽値</option>
                  <option value="date">日付</option>
                  <option value="datetime">日時</option>
                  <option value="list">リスト</option>
                  {row.type === 'object' && <option value="object">オブジェクト</option>}
                </select>

                {/* 値入力 */}
                <div className="min-w-0">
                  <PropertyValueInput
                    row={row}
                    error={error}
                    onChange={handleValueChange}
                  />
                </div>

                {/* 削除ボタン */}
                <button
                  type="button"
                  aria-label={`${row.key} を削除`}
                  onClick={() => handleDeleteRow(row)}
                  className="flex h-6 w-6 items-center justify-center rounded text-xs text-ink-faint hover:bg-hoverbg hover:text-danger"
                >
                  ×
                </button>
              </div>

              {/* エラーメッセージ */}
              {error && (
                <p role="alert" id={errorId} className="text-xs text-danger">
                  {error}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* readonlyUpdated 行 */}
      {readonlyUpdated && (
        <div
          data-testid="property-row-updated"
          className="flex flex-wrap items-center gap-2 border-t border-line/40 pt-2 text-xs"
        >
          <span className="font-mono text-ink-faint">updated</span>
          <span className="text-ink-soft">
            <PropertyValue
              entry={{
                key: 'updated',
                value: readonlyUpdated.value,
                kind: classifyPropertyValue(readonlyUpdated.value),
              }}
            />
          </span>
          <span className="text-ink-faint">（保存時に自動更新）</span>
        </div>
      )}

      {/* 項目追加ボタン */}
      <div>
        <button
          type="button"
          data-testid="properties-add"
          onClick={handleAddRow}
          className="rounded border border-dashed border-line px-2 py-1 text-xs text-ink-faint hover:border-line/80 hover:bg-hoverbg hover:text-ink-soft"
        >
          ＋ 項目を追加
        </button>
      </div>
    </div>
  );
}
