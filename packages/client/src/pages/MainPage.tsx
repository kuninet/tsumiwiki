import { useNavigate } from 'react-router-dom';
import { useRecentDocs } from '../api/search';
import { CloseConfirmDialog } from '../components/CloseConfirmDialog';
import { PaneLayout } from '../components/PaneLayout';
import { useTabsUrlSync } from '../hooks/use-tabs-url-sync';
import { docUrl } from '../lib/doc-path';
import { useHasAnyOpenTab, useLayoutRoot } from '../stores/tabs';

// メイン画面(SC-02)。文書未選択時は最近更新一覧、選択時はタブ + 分割ペインで閲覧・編集。
// Epic #133 Phase A-1: タブ + マウント保存(切替時に DocView を unmount しない)
// Epic #133 Phase B: 二分木レイアウトツリーの再帰レンダー(PaneLayout)

function RecentDocsList() {
  const { data: docs, isLoading } = useRecentDocs();
  const navigate = useNavigate();

  return (
    <div className="p-6">
      <h1 className="text-h1 font-bold text-ink">最近更新した文書</h1>

      {isLoading && <p className="mt-4 text-sm text-ink-faint">読み込み中...</p>}

      {!isLoading && (docs ?? []).length === 0 && (
        <p className="mt-4 text-sm text-ink-faint">文書がありません</p>
      )}

      {!isLoading && (docs ?? []).length > 0 && (
        <ul className="mt-4 divide-y divide-line">
          {(docs ?? []).map((doc) => (
            <li key={doc.path}>
              <button
                type="button"
                onClick={() => navigate(docUrl(doc.path))}
                className="block w-full py-2 text-left hover:bg-hoverbg"
              >
                <div className="text-sm font-medium text-ink">{doc.title}</div>
                <div className="text-xs text-ink-faint">
                  {doc.folder || '(ルート)'} ・ {doc.updatedAt}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MainPage() {
  const urlPath = useTabsUrlSync();
  const root = useLayoutRoot();
  const hasAnyTab = useHasAnyOpenTab();

  // どのペインにもタブが無く URL も無いなら最近更新一覧
  if (!hasAnyTab && !urlPath) {
    return <RecentDocsList />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <PaneLayout node={root} />
        {/* URL が空(ルート戻りなど)でタブは残っているケース: 上に最近一覧を重ねる */}
        {!urlPath && hasAnyTab && (
          <div className="h-full overflow-auto">
            <RecentDocsList />
          </div>
        )}
      </div>
      {/* dirty タブ閉じ確認(Phase A-2)。pendingClose が null のときは自分で描画しない */}
      <CloseConfirmDialog />
    </div>
  );
}
