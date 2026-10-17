import { Fragment, useId, useMemo, useState } from 'react';
import { visiblePropertyEntries } from '../lib/frontmatter-display';
import { PropertyValue } from './PropertyValue';

export interface PropertiesPanelProps {
  frontmatter: unknown;
}

// フロントマター（プロパティ）の折りたたみ表示パネル(#281)
export function PropertiesPanel({ frontmatter }: PropertiesPanelProps) {
  const [open, setOpen] = useState(false);
  const buttonId = useId();
  const bodyId = useId();

  // 表示対象のプロパティを抽出
  const entries = useMemo(() => visiblePropertyEntries(frontmatter), [frontmatter]);

  // 表示対象のプロパティがなければ描画しない(null)
  if (entries.length === 0) {
    return null;
  }

  return (
    <section data-testid="properties-panel" className="mb-3 rounded border border-line">
      <button
        type="button"
        id={buttonId}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-1 px-3 py-1.5 text-xs text-ink-faint hover:bg-hoverbg"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span>プロパティ ({entries.length}件)</span>
      </button>

      {open && (
        <div id={bodyId} role="region" aria-labelledby={buttonId}>
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
        </div>
      )}
    </section>
  );
}
