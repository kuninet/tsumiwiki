import { useNavigate } from 'react-router-dom';
import { useDocsByTags, useTags } from '../api/tags';
import { docUrl } from '../lib/doc-path';
import { confirmNavigationIfDirty } from '../lib/navigation-guard';
import { useUIStore } from '../stores/ui';

// タグペイン(設計04章4.2)。複数選択でAND絞り込みし、該当文書一覧を下に表示する


export function TagPane() {
  const { data: tags } = useTags();
  const selectedTags = useUIStore((s) => s.selectedTags);
  const toggleTag = useUIStore((s) => s.toggleTag);
  const clearTags = useUIStore((s) => s.clearTags);
  const { data: docs } = useDocsByTags(selectedTags);
  const navigate = useNavigate();

  function handleNavigateToDoc(path: string) {
    if (!confirmNavigationIfDirty()) {
      return;
    }
    navigate(docUrl(path));
  }

  return (
    <div className="p-2">
      <ul>
        {(tags ?? []).map((t) => {
          const selected = selectedTags.includes(t.tag);
          return (
            <li key={t.tag}>
              <button
                type="button"
                onClick={() => toggleTag(t.tag)}
                aria-pressed={selected}
                className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm ${
                  selected ? 'bg-blue-50 font-medium text-blue-700' : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                <span>{t.tag}</span>
                <span className="text-xs text-gray-400">{t.count}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {selectedTags.length > 0 && (
        <div className="mt-3 border-t border-gray-200 pt-2">
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-xs text-gray-500">絞り込み結果</span>
            <button type="button" onClick={clearTags} className="text-xs text-blue-600 hover:underline">
              選択解除
            </button>
          </div>
          <ul>
            {(docs ?? []).map((doc) => (
              <li key={doc.path}>
                <button
                  type="button"
                  onClick={() => handleNavigateToDoc(doc.path)}
                  className="block w-full truncate rounded px-2 py-1 text-left text-sm text-gray-700 hover:bg-gray-100"
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
