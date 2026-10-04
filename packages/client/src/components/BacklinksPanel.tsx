import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBacklinks } from '../api/backlinks';
import { docUrl } from '../lib/doc-path';
import { formatBacklinkContext } from '../lib/format-backlink-context';
import { relativeTime } from '../lib/relative-time';
import {
  type BacklinksSortOrder,
  useUserSettingsStore,
} from '../stores/user-settings';

// バックリンク一覧パネル(#267)
// 文書末尾に折りたたみ可能なセクションとして配置される。
// props は path と enabled(表示中タブフラグ) のみとし、独立した部品として運用可能にする。

interface BacklinksPanelProps {
  path: string;
  enabled?: boolean;
}

/**
 * ネットワーク切断・サーバー到達不可(オフライン)のエラーかどうかを判定する(#267 レビューM3対応)。
 * Fetch API(TypeError: Failed to fetch等)やAxios(ERR_NETWORK等)のエラー構成に対応する。
 */
export function isOfflineOrNetworkError(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return true;
  }
  if (!error) return false;

  if (error instanceof TypeError) {
    return true;
  }

  if (typeof error === 'object') {
    const err = error as Record<string, unknown>;
    if (err.code === 'ERR_NETWORK') return true;
    if (err.isAxiosError && !err.response) return true;
    if (err.status === 0) return true;

    if (typeof err.message === 'string') {
      const msg = err.message.toLowerCase();
      if (
        msg.includes('failed to fetch') ||
        msg.includes('network') ||
        msg.includes('networkerror') ||
        msg.includes('fetch failed') ||
        msg.includes('offline') ||
        msg.includes('econnrefused')
      ) {
        return true;
      }
    }
  }

  return false;
}

function BacklinkContextView({ context }: { context: string }) {
  const segments = formatBacklinkContext(context);
  return (
    <span>
      {segments.map((seg, i) =>
        seg.isLink ? (
          <span key={i} className="font-semibold text-ink bg-hoverbg px-0.5 rounded">
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </span>
  );
}

export function BacklinksPanel({ path, enabled = true }: BacklinksPanelProps) {
  const navigate = useNavigate();

  const collapsed = useUserSettingsStore((s) => s.backlinksCollapsed);
  const setCollapsed = useUserSettingsStore((s) => s.setBacklinksCollapsed);
  const sortOrder = useUserSettingsStore((s) => s.backlinksSort);
  const setSortOrder = useUserSettingsStore((s) => s.setBacklinksSort);

  // 非表示タブまたは折りたたみ中はフェッチを抑止する
  const isFetchEnabled = enabled && !collapsed;
  const { data, isLoading, error } = useBacklinks(path, { enabled: isFetchEnabled });

  // ソート順の適用: 更新日降順(既定)または名前順降順
  const sortedBacklinks = useMemo(() => {
    if (!data?.backlinks || !Array.isArray(data.backlinks)) return [];
    const list = [...data.backlinks];
    if (sortOrder === 'name-desc') {
      list.sort((a, b) => b.sourceTitle.localeCompare(a.sourceTitle, 'ja'));
    } else {
      list.sort((a, b) => {
        if (a.sourceUpdatedAt !== b.sourceUpdatedAt) {
          return a.sourceUpdatedAt < b.sourceUpdatedAt ? 1 : -1;
        }
        return a.sourcePath.localeCompare(b.sourcePath, 'ja');
      });
    }
    return list;
  }, [data?.backlinks, sortOrder]);

  const countText =
    !collapsed && Array.isArray(data?.backlinks)
      ? ` (${data.backlinks.length}${data.truncated ? '+' : ''})`
      : '';

  const isOffline = isOfflineOrNetworkError(error);

  return (
    <section
      data-testid="backlinks-panel"
      className="mt-8 pt-4 border-t border-line text-sm"
      aria-label="バックリンク"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          data-testid="backlinks-toggle-btn"
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-1.5 font-medium text-ink-soft hover:text-ink select-none cursor-pointer text-left"
          aria-expanded={!collapsed}
        >
          <span className="text-xs text-ink-faint inline-block w-3 text-center" aria-hidden="true">
            {collapsed ? '▶' : '▼'}
          </span>
          <span>この文書へのリンク{countText}</span>
        </button>

        {!collapsed && Array.isArray(data?.backlinks) && data.backlinks.length > 0 && (
          <div className="flex items-center gap-1 text-xs text-ink-faint">
            <label htmlFor="backlinks-sort-select" className="sr-only">
              並び順
            </label>
            <select
              id="backlinks-sort-select"
              data-testid="backlinks-sort-select"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as BacklinksSortOrder)}
              className="rounded border border-line bg-canvas px-1.5 py-0.5 text-xs text-ink-soft hover:border-line focus:outline-none"
            >
              <option value="updated-desc">更新日順</option>
              <option value="name-desc">名前順(降順)</option>
            </select>
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="mt-3">
          {isLoading && (
            <div data-testid="backlinks-loading" className="text-xs text-ink-faint py-2">
              読み込み中...
            </div>
          )}

          {error && (
            <div data-testid="backlinks-error" className="text-xs text-ink-faint py-2">
              {isOffline
                ? 'オフラインまたはサーバー未稼働のため表示できません'
                : 'バックリンクを取得できませんでした'}
            </div>
          )}

          {!isLoading && !error && Array.isArray(data?.backlinks) && (
            <>
              {sortedBacklinks.length === 0 ? (
                <div data-testid="backlinks-empty" className="text-xs text-ink-faint py-2">
                  この文書へのリンクはありません
                </div>
              ) : (
                <ul data-testid="backlinks-list" className="divide-y divide-line/60">
                  {sortedBacklinks.map((entry) => (
                    <li key={entry.sourcePath} className="py-2 first:pt-0 last:pb-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <button
                          type="button"
                          data-testid={`backlink-item-${entry.sourcePath}`}
                          onClick={() => navigate(docUrl(entry.sourcePath))}
                          className="font-medium text-primary hover:underline text-left truncate cursor-pointer text-sm"
                          title={entry.sourcePath}
                        >
                          {entry.sourceTitle}
                        </button>
                        <div className="flex items-center gap-2 text-xs text-ink-faint flex-shrink-0">
                          {entry.sourceFolder && <span>{entry.sourceFolder}</span>}
                          {entry.sourceUpdatedAt && (
                            <span>{relativeTime(entry.sourceUpdatedAt)}</span>
                          )}
                        </div>
                      </div>

                      {entry.links.length > 0 && (
                        <div className="mt-1 space-y-1 pl-2 border-l-2 border-line/60">
                          {entry.links.map((link, idx) => (
                            <div key={idx} className="text-xs text-ink-soft leading-relaxed">
                              <BacklinkContextView context={link.context} />
                            </div>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {data.truncated && (
                <div data-testid="backlinks-truncated" className="text-xs text-ink-faint mt-2">
                  上位200件のみ表示しています
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
