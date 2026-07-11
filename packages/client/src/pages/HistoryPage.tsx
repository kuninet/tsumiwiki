import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AllHistoryEntry, HistoryEntry } from '@tsumiwiki/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiRequestError } from '../api/client';
import { docQueryKey, TREE_QUERY_KEY, useTree } from '../api/docs';
import {
  ALL_HISTORY_QUERY_KEY,
  fetchHistoryCommitDiff,
  fetchHistoryContent,
  fetchHistoryDiff,
  historyQueryKey,
  restoreRevision,
  useAllHistory,
  useHistory,
} from '../api/history';
import { acquireLock, releaseLock } from '../api/locks';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DiffView } from '../components/DiffView';
import { SideBySideDiffView } from '../components/SideBySideDiffView';
import { docUrl } from '../lib/doc-path';
import { parseDiff } from '../lib/parse-diff';
import { relativeTime } from '../lib/relative-time';
import { useToastStore } from '../stores/toast';

// 履歴の全画面ページ(SC-03の全画面版。設計04章4.1・issue #66 Phase 1b)
// ロジックはHistoryPanelから複製している(Phase 2でMerged view実装時に共通化を検討)

type Tab = 'diff' | 'content';
// 差分の表示レイアウト(全画面ページのみ。右サイドパネルは狭いため1列固定。issue #66 Phase 1c)
type Layout = 'inline' | 'side-by-side';

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP');
}

function titleFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

function isAllHistoryEntry(entry: HistoryEntry | AllHistoryEntry): entry is AllHistoryEntry {
  return 'paths' in entry;
}

export function HistoryPage() {
  const params = useParams();
  const path = params['*'];
  const navigate = useNavigate();
  const [scope, setScope] = useState<'file' | 'all'>('file');
  const [layout, setLayout] = useState<Layout>('inline');
  const { data: fileHistory, isLoading: fileLoading } = useHistory(path);
  const { data: allHistory, isLoading: allLoading } = useAllHistory(scope === 'all');
  const history = scope === 'all' ? allHistory : fileHistory;
  const isLoading = scope === 'all' ? allLoading : fileLoading;
  // #96: 差分表示内の wikilink をクリック可能にするため、DiffView に docs 一覧を渡す
  const { data: tree } = useTree();
  const [selectedRev, setSelectedRev] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('diff');
  const [restoreConfirmVisible, setRestoreConfirmVisible] = useState(false);
  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);

  // Escapeキーで文書に戻る(HistoryPanelのEscape動作を踏襲)。
  // 復元確認ダイアログ表示中や入力欄フォーカス中は他のEscapeハンドラを優先し、
  // 意図しないページ遷移(検索候補閉じ・ダイアログキャンセルが遷移に化ける等)を防ぐ
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || !path) return;
      if (restoreConfirmVisible) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }
      navigate(docUrl(path));
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate, path, restoreConfirmVisible]);

  // スコープ切替時は選択中の版をリセットする。「全体」は差分タブのみのため合わせて固定する
  useEffect(() => {
    setSelectedRev(null);
    if (scope === 'all') setTab('diff');
  }, [scope]);

  // 初回取得時は最新版を選択状態にする
  useEffect(() => {
    if (history && history.length > 0 && !selectedRev) {
      setSelectedRev(history[0].rev);
    }
  }, [history, selectedRev]);

  // 「全体」スコープでは1コミット内の代表1ファイル(paths[0])を差分対象にする
  const selectedAllEntry =
    scope === 'all' ? (allHistory ?? []).find((e) => e.rev === selectedRev) : undefined;
  const diffTargetPath = scope === 'all' ? selectedAllEntry?.paths[0] : path;

  const { data: content } = useQuery({
    queryKey: ['history-content', path, selectedRev],
    queryFn: () => fetchHistoryContent(path!, selectedRev!),
    enabled: !!path && !!selectedRev && tab === 'content' && scope === 'file',
  });

  // 「この文書」時は rev↔HEAD、「全体」時は rev^↔rev(そのコミット単体の差分)
  const { data: diff, isError: diffError } = useQuery({
    queryKey:
      scope === 'all'
        ? ['history-commit-diff', diffTargetPath, selectedRev]
        : ['history-diff', diffTargetPath, selectedRev],
    queryFn: () =>
      scope === 'all'
        ? fetchHistoryCommitDiff(diffTargetPath!, selectedRev!)
        : fetchHistoryDiff(diffTargetPath!, selectedRev!),
    enabled: !!selectedRev && tab === 'diff' && !!diffTargetPath,
    retry: false,
  });

  const diffLines = diff ? parseDiff(diff) : [];

  async function handleRestore() {
    setRestoreConfirmVisible(false);
    if (!path || !selectedRev) return;
    try {
      await acquireLock(path);
    } catch (err) {
      showToast('error', err instanceof ApiRequestError ? err.message : 'ロックを取得できませんでした');
      return;
    }
    try {
      await restoreRevision(path, selectedRev);
      queryClient.invalidateQueries({ queryKey: docQueryKey(path) });
      queryClient.invalidateQueries({ queryKey: historyQueryKey(path) });
      queryClient.invalidateQueries({ queryKey: ALL_HISTORY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
      showToast('success', 'この版に戻しました');
      navigate(docUrl(path)); // 復元後は文書に戻る
    } catch (err) {
      showToast('error', err instanceof ApiRequestError ? err.message : '復元に失敗しました');
    } finally {
      await releaseLock(path).catch(() => {});
    }
  }

  if (!path) {
    return <div className="p-6 text-ink-faint">文書が指定されていません</div>;
  }

  return (
    <div className="mx-auto flex h-full max-w-[900px] flex-col p-4 sm:p-6 lg:p-8">
      <div className="flex-shrink-0 border-b border-line pb-3 mb-3">
        <div className="flex items-center justify-between">
          <h1 className="truncate text-xl font-bold text-ink">
            履歴 <span className="text-ink-faint">·</span> {titleFromPath(path)}
          </h1>
          <Link to={docUrl(path)} className="flex-shrink-0 text-sm text-ink-faint hover:text-ink">
            ← 文書に戻る
          </Link>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <div
            className="inline-flex rounded-full border border-line p-0.5"
            role="tablist"
            aria-label="履歴のスコープ"
          >
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'file'}
              onClick={() => setScope('file')}
              className={`rounded-full px-3 py-1 text-xs ${
                scope === 'file' ? 'bg-active font-semibold text-accent' : 'text-ink-faint'
              }`}
            >
              この文書
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'all'}
              onClick={() => setScope('all')}
              className={`rounded-full px-3 py-1 text-xs ${
                scope === 'all' ? 'bg-active font-semibold text-accent' : 'text-ink-faint'
              }`}
            >
              全体
            </button>
          </div>

          <div
            className="inline-flex rounded-full border border-line p-0.5"
            role="tablist"
            aria-label="差分レイアウト"
          >
            <button
              type="button"
              role="tab"
              aria-selected={layout === 'inline'}
              onClick={() => setLayout('inline')}
              className={`rounded-full px-3 py-1 text-xs ${
                layout === 'inline' ? 'bg-active font-semibold text-accent' : 'text-ink-faint'
              }`}
            >
              1列
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={layout === 'side-by-side'}
              onClick={() => setLayout('side-by-side')}
              className={`rounded-full px-3 py-1 text-xs ${
                layout === 'side-by-side' ? 'bg-active font-semibold text-accent' : 'text-ink-faint'
              }`}
            >
              2列
            </button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="max-h-[45%] flex-shrink-0 overflow-y-auto border-b border-line">
          {isLoading && <p className="p-3 text-sm text-ink-faint">読み込み中...</p>}
          {!isLoading && (history ?? []).length === 0 && (
            <p className="p-3 text-sm text-ink-faint">履歴がありません</p>
          )}
          <ul>
            {(history ?? []).map((entry) => (
              <li key={entry.rev}>
                <button
                  type="button"
                  onClick={() => setSelectedRev(entry.rev)}
                  className={`flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left ${
                    selectedRev === entry.rev ? 'bg-active' : 'hover:bg-hoverbg'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white"
                  >
                    {entry.authorName.charAt(0)}
                  </span>
                  <span className="min-w-0 flex-1">
                    {isAllHistoryEntry(entry) ? (
                      <>
                        <span
                          className="block truncate text-sm text-ink"
                          title={entry.paths.join(', ')}
                        >
                          {titleFromPath(entry.paths[0])}
                          {entry.paths.length > 1 && (
                            <span className="text-ink-faint"> +他{entry.paths.length - 1}件</span>
                          )}
                        </span>
                        <span
                          className="mt-0.5 block truncate text-xs text-ink-faint"
                          title={formatDateTime(entry.date)}
                        >
                          {relativeTime(entry.date)} ・ {entry.authorName} ・ {entry.message}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="block text-sm text-ink" title={formatDateTime(entry.date)}>
                          {relativeTime(entry.date)}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-ink-faint">
                          {entry.authorName} ・ {entry.message}
                        </span>
                      </>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {scope === 'file' && (
          <p className="flex-shrink-0 py-1 text-[11px] text-ink-faint">
            ※ リネームがあった場合、リネーム前の履歴は含まれません
          </p>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-shrink-0 border-b border-line">
            <button
              type="button"
              onClick={() => setTab('diff')}
              className={`px-3 py-2 text-sm ${
                tab === 'diff' ? 'border-b-2 border-accent font-semibold text-accent' : 'text-ink-faint'
              }`}
            >
              差分
            </button>
            <button
              type="button"
              onClick={() => setTab('content')}
              disabled={scope === 'all'}
              className={`px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
                tab === 'content' ? 'border-b-2 border-accent font-semibold text-accent' : 'text-ink-faint'
              }`}
            >
              内容
            </button>
          </div>

          <div className="flex-1 overflow-auto p-3">
            {scope === 'all' && diffTargetPath && (
              <p className="mb-2 truncate text-xs text-ink-faint">表示中: {diffTargetPath}</p>
            )}
            {tab === 'content' && scope === 'file' && (
              <pre className="whitespace-pre-wrap text-sm text-ink">{content ?? ''}</pre>
            )}
            {tab === 'diff' && diffError && (
              <p className="text-xs text-ink-faint">このパスの差分は表示できません</p>
            )}
            {tab === 'diff' && !diffError && layout === 'side-by-side' && (
              <SideBySideDiffView lines={diffLines} docs={tree?.docs ?? []} />
            )}
            {tab === 'diff' && !diffError && layout === 'inline' && (
              <DiffView lines={diffLines} docs={tree?.docs ?? []} />
            )}
          </div>

          {scope === 'file' && (
            <div className="flex-shrink-0 border-t border-line p-3">
              <button
                type="button"
                disabled={!selectedRev}
                onClick={() => setRestoreConfirmVisible(true)}
                className="rounded bg-accent px-4 py-1.5 text-sm text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                この版に戻す
              </button>
            </div>
          )}
        </div>
      </div>

      {restoreConfirmVisible && (
        <ConfirmDialog
          title="この版に戻す"
          message="現在の内容を破棄してこの版に戻します。よろしいですか?"
          confirmLabel="戻す"
          variant="primary"
          onConfirm={() => void handleRestore()}
          onCancel={() => setRestoreConfirmVisible(false)}
        />
      )}
    </div>
  );
}
