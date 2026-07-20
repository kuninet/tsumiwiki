import { useNavigate } from 'react-router-dom';
import { useRecentDocs } from '../api/search';
import { CloseConfirmDialog } from '../components/CloseConfirmDialog';
import { DocTab } from '../components/DocTab';
import { TabBar } from '../components/TabBar';
import { useTabsUrlSync } from '../hooks/use-tabs-url-sync';
import { docUrl } from '../lib/doc-path';
import { useActivePaneActiveId, useActivePaneTabs } from '../stores/tabs';

// メイン画面(SC-02)。文書未選択時は最近更新一覧、選択時はタブモデルで閲覧・編集する。
// Epic #133 Phase A-1 でタブ + マウント保存(切替時に DocView を unmount しない)に対応。

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
  // Phase B: 活性ペインの tabs / activeId(単一ペイン挙動を維持)。
  // 分割 UI は Phase B2 で MainPage をツリー再帰レンダーに置き換える予定
  const tabs = useActivePaneTabs();
  const activeId = useActivePaneActiveId();

  // タブが1つも無く URL も無い状態は「最近更新した文書」の一覧を出す
  if (tabs.length === 0 && !urlPath) {
    return <RecentDocsList />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TabBar />
      <div className="min-h-0 flex-1">
        {/* すべてのタブは常時マウントしておき、非アクティブは hidden で隠す。
            これで切替時に Tiptap インスタンスや useEditingSession の state が失われず、
            スクロール位置・カーソル・dirty な編集内容が保持される。 */}
        {tabs.map((tab) => (
          <DocTabWrapper
            key={tab.path}
            path={tab.path}
            active={tab.path === activeId && urlPath === tab.path}
          />
        ))}
        {/* URL が空(ルート戻りなど)でタブは残っているケース: 上に最近一覧を重ねる */}
        {!urlPath && tabs.length > 0 && (
          <div className="h-full overflow-auto">
            <RecentDocsList />
          </div>
        )}
      </div>
      {/* dirty タブ閉じ確認(Phase A-2)。pendingCloseId が null のときは自分で描画しない */}
      <CloseConfirmDialog />
    </div>
  );
}

// map の親側で active/hidden を判定するので、h-full 相当のラッパーで包む
function DocTabWrapper({ path, active }: { path: string; active: boolean }) {
  return (
    <div className={active ? 'h-full' : 'hidden'}>
      <DocTab path={path} active={active} />
    </div>
  );
}
