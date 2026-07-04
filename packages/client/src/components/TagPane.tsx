import { useNavigate } from 'react-router-dom';
import { useDocsByTags, useTags } from '../api/tags';
import { docUrl } from '../lib/doc-path';
import { useEditStore } from '../stores/edit';
import { useUIStore } from '../stores/ui';

// タグペイン(設計04章4.2・デザインhandoff components.md)。複数選択でAND絞り込みし、
// 該当文書一覧を下に表示する

const UNSAVED_NAVIGATION_WARNING = '未保存の変更があります。移動しますか?';

export function TagPane() {
  const { data: tags } = useTags();
  const selectedTags = useUIStore((s) => s.selectedTags);
  const toggleTag = useUIStore((s) => s.toggleTag);
  const clearTags = useUIStore((s) => s.clearTags);
  const { data: docs } = useDocsByTags(selectedTags);
  const navigate = useNavigate();

  function handleNavigateToDoc(path: string) {
    if (useEditStore.getState().dirty && !window.confirm(UNSAVED_NAVIGATION_WARNING)) {
      return;
    }
    navigate(docUrl(path));
  }

  return (
    <div className="p-2">
      {selectedTags.length > 0 && (
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-xs text-ink-faint">絞り込み中</span>
          <button type="button" onClick={clearTags} className="text-xs text-accent hover:underline">
            全解除
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 p-1">
        {(tags ?? []).map((t) => {
          const selected = selectedTags.includes(t.tag);
          return (
            <button
              key={t.tag}
              type="button"
              onClick={() => toggleTag(t.tag)}
              aria-pressed={selected}
              className={`rounded-full border px-2.5 py-1 text-sm ${
                selected
                  ? 'border-accent-border bg-accent-soft text-accent'
                  : 'border-line bg-panel-2 text-ink-soft hover:bg-hoverbg'
              }`}
            >
              <span>{`#${t.tag}`}</span> <span className="text-ink-faint">{t.count}</span>
            </button>
          );
        })}
      </div>

      {selectedTags.length > 0 && (
        <div className="mt-3 border-t border-line pt-2">
          <div className="mb-1 px-1 text-xs text-ink-faint">絞り込み結果</div>
          <ul>
            {(docs ?? []).map((doc) => (
              <li key={doc.path}>
                <button
                  type="button"
                  onClick={() => handleNavigateToDoc(doc.path)}
                  className="block w-full truncate rounded px-2 py-1 text-left text-sm text-ink-soft hover:bg-hoverbg"
                >
                  {doc.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
