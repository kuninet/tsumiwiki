import { useNavigate } from 'react-router-dom';
import { docUrl, titleFromPath } from '../lib/doc-path';
import { useTabsStore } from '../stores/tabs';

// 編集/閲覧ペインのタブバー(Epic #133 / Phase A-1)。
// - preview タブは斜体で表示
// - dirty タブは先頭に「●」を付与
// - タブクリックでアクティブ切替(URL は同時に /doc/* へ追随させる)
// - タブをダブルクリックで pinned に昇格(preview の場合)
//
// 閉じる(×)・middle-click・並べ替え D&D は Phase A-2(#135) で追加する。

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const setActive = useTabsStore((s) => s.setActive);
  const promoteToPinned = useTabsStore((s) => s.promoteToPinned);
  const navigate = useNavigate();

  if (tabs.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="文書タブ"
      data-testid="tabbar"
      className="flex flex-shrink-0 items-stretch overflow-x-auto border-b border-line bg-panel"
    >
      {tabs.map((tab) => {
        const isActive = tab.path === activeId;
        const italic = tab.kind === 'preview' ? 'italic' : '';
        const activeCls = isActive
          ? 'bg-canvas text-ink border-b-2 border-accent'
          : 'text-ink-soft border-b-2 border-transparent hover:bg-hoverbg';
        return (
          <button
            key={tab.path}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-testid={`tab-${tab.path}`}
            title={tab.path}
            onClick={() => {
              // 既にアクティブなタブなら何もしない(useParams の再生成で余計な effect が
              // 走るのを避ける L2)
              if (isActive) return;
              setActive(tab.path);
              navigate(docUrl(tab.path));
            }}
            onDoubleClick={() => {
              if (tab.kind === 'preview') promoteToPinned(tab.path);
            }}
            className={`flex min-w-0 max-w-[220px] items-center gap-1 px-3 py-1.5 text-sm ${italic} ${activeCls}`}
          >
            {tab.dirty && (
              <span aria-hidden="true" className="flex-shrink-0 text-accent">
                ●
              </span>
            )}
            <span className="truncate">{titleFromPath(tab.path)}</span>
          </button>
        );
      })}
    </div>
  );
}
