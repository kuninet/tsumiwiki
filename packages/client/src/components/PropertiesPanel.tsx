import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import { visiblePropertyEntries } from '../lib/frontmatter-display';
import {
  buildFrontmatterOps,
  createEmptyRow,
  getNextSeq,
  visibleRowCount,
  type PropertyRowsState,
} from '../lib/frontmatter-edit';
import { PropertyEditor } from './PropertyEditor';
import { PropertyValue } from './PropertyValue';

export interface PropertiesPanelProps {
  frontmatter: unknown;
  editable?: boolean;
  frontmatterStatus?: 'ok' | 'none' | 'invalid';
  rows?: PropertyRowsState;
  errors?: Map<string, string>;
  onRowsChange?: (next: PropertyRowsState) => void;
}

// フロントマター（プロパティ）の折りたたみ表示・編集パネル(#281, #282)
export function PropertiesPanel({
  frontmatter,
  editable,
  frontmatterStatus,
  rows,
  errors,
  onRowsChange,
}: PropertiesPanelProps) {
  const [open, setOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const buttonId = useId();
  const bodyId = useId();

  // 表示対象のプロパティを抽出
  const entries = useMemo(() => visiblePropertyEntries(frontmatter), [frontmatter]);

  // updated が存在するかどうか
  const hasUpdated = useMemo(
    () =>
      frontmatter != null &&
      typeof frontmatter === 'object' &&
      !Array.isArray(frontmatter) &&
      'updated' in frontmatter,
    [frontmatter],
  );

  // editable が false になったらフォーム表示を閉じる
  useEffect(() => {
    if (!editable) {
      setFormOpen(false);
    }
  }, [editable]);

  // 件数の計算: フォーム表示中は rows から数える（updated があれば +1）
  const count =
    formOpen && rows ? visibleRowCount(rows) + (hasUpdated ? 1 : 0) : entries.length;

  // 0 件かつフォームが開いていない場合の分岐
  if (entries.length === 0 && !formOpen) {
    if (editable && frontmatterStatus !== 'invalid') {
      const handleAddFirst = () => {
        setOpen(true);
        setFormOpen(true);
        const baseState = rows ?? { rows: [], removedKeys: [] };
        const seq = getNextSeq(baseState.rows);
        const newRow = createEmptyRow(seq);
        onRowsChange?.({
          ...baseState,
          rows: [...baseState.rows, newRow],
        });
      };

      return (
        <div data-testid="properties-add-first-wrap" className="mb-3">
          <button
            type="button"
            data-testid="properties-add-first"
            onClick={handleAddFirst}
            className="text-xs text-ink-faint hover:text-ink-soft"
          >
            ＋ プロパティを追加
          </button>
        </div>
      );
    }
    return null;
  }

  // 完了ボタンの disabled 判定（エラーがあるか、未保存 ops がある場合は disabled）
  const hasErrors = (errors?.size ?? 0) > 0;
  const currentOps = rows ? buildFrontmatterOps(rows) : [];
  const isDoneDisabled = hasErrors || currentOps.length > 0;

  return (
    <section data-testid="properties-panel" className="mb-3 rounded border border-line">
      <div className="flex w-full items-center justify-between px-3 py-1.5 text-xs text-ink-faint">
        <button
          type="button"
          id={buttonId}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((prev) => !prev)}
          className="flex items-center gap-1 rounded py-0.5 pr-2 hover:bg-hoverbg"
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span>プロパティ ({count}件)</span>
        </button>

        {editable && (
          <div>
            {frontmatterStatus === 'invalid' ? (
              <span
                className="text-xs text-ink-faint"
                title="フロントマターを解釈できないため、ここでは編集できません"
              >
                編集不可
              </span>
            ) : formOpen ? (
              <button
                type="button"
                aria-label="入力を終える"
                disabled={isDoneDisabled}
                title={isDoneDisabled ? '保存または破棄すると閉じられます' : undefined}
                onClick={() => setFormOpen(false)}
                className="rounded px-1.5 py-0.5 text-xs text-ink-faint hover:bg-hoverbg disabled:opacity-50"
              >
                完了
              </button>
            ) : (
              <button
                type="button"
                data-testid="properties-edit"
                aria-label="項目を変更する"
                onClick={() => {
                  setOpen(true);
                  setFormOpen(true);
                }}
                className="rounded px-1.5 py-0.5 text-xs text-ink-faint hover:bg-hoverbg"
              >
                変更
              </button>
            )}
          </div>
        )}
      </div>

      {open && (
        <div id={bodyId} role="region" aria-labelledby={buttonId}>
          {formOpen && rows ? (
            <PropertyEditor
              state={rows}
              errors={errors ?? new Map()}
              onChange={onRowsChange ?? (() => {})}
              readonlyUpdated={
                hasUpdated
                  ? { value: (frontmatter as Record<string, unknown>).updated }
                  : undefined
              }
            />
          ) : (
            <dl
              data-testid="properties-list"
              className="grid grid-cols-1 items-baseline gap-x-4 gap-y-1 px-3 pt-1 pb-2 text-sm sm:grid-cols-[minmax(6rem,max-content)_1fr]"
            >
              {entries.map((entry) => (
                <Fragment key={entry.key}>
                  <dt
                    className="break-all font-mono text-xs text-ink-faint"
                    title={entry.key}
                  >
                    {entry.key}
                  </dt>
                  <dd className="min-w-0 break-words text-ink-soft">
                    <PropertyValue entry={entry} />
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
        </div>
      )}
    </section>
  );
}
