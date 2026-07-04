import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiRequestError } from '../api/client';
import { docQueryKey, TREE_QUERY_KEY } from '../api/docs';
import {
  fetchHistoryContent,
  fetchHistoryDiff,
  historyQueryKey,
  restoreRevision,
  useHistory,
} from '../api/history';
import { acquireLock, releaseLock } from '../api/locks';
import { parseDiff } from '../lib/parse-diff';
import { useToastStore } from '../stores/toast';
import { ConfirmDialog } from './ConfirmDialog';

// 履歴パネル(SC-03。設計04章4.3)。DocViewの[履歴]ボタンから開く右スライドパネル

interface HistoryPanelProps {
  path: string;
  onClose: () => void;
}

type Tab = 'diff' | 'content';

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP');
}

const DIFF_LINE_CLASS: Record<string, string> = {
  add: 'bg-green-50 text-green-800',
  del: 'bg-red-50 text-red-800',
  hunk: 'bg-slate-100 text-slate-500',
  meta: 'text-gray-400',
  context: 'text-gray-700',
};

export function HistoryPanel({ path, onClose }: HistoryPanelProps) {
  // Escapeキーでパネルを閉じる(操作性・a11y)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const { data: history, isLoading } = useHistory(path);
  const [selectedRev, setSelectedRev] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('diff');
  const [restoreConfirmVisible, setRestoreConfirmVisible] = useState(false);
  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);

  // 初回取得時は最新版を選択状態にする
  useEffect(() => {
    if (history && history.length > 0 && !selectedRev) {
      setSelectedRev(history[0].rev);
    }
  }, [history, selectedRev]);

  const { data: content } = useQuery({
    queryKey: ['history-content', path, selectedRev],
    queryFn: () => fetchHistoryContent(path, selectedRev!),
    enabled: !!selectedRev && tab === 'content',
  });

  const { data: diff } = useQuery({
    queryKey: ['history-diff', path, selectedRev],
    queryFn: () => fetchHistoryDiff(path, selectedRev!),
    enabled: !!selectedRev && tab === 'diff',
  });

  const diffLines = diff ? parseDiff(diff) : [];

  async function handleRestore() {
    setRestoreConfirmVisible(false);
    if (!selectedRev) return;
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
      queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
      showToast('success', 'この版に戻しました');
      onClose(); // 復元後は旧版選択が残らないようパネルを閉じる
    } catch (err) {
      showToast('error', err instanceof ApiRequestError ? err.message : '復元に失敗しました');
    } finally {
      await releaseLock(path).catch(() => {});
    }
  }

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-[400px] flex-col border-l border-gray-200 bg-white shadow-xl">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3">
        <h2 className="text-sm font-bold text-gray-800">履歴</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="閉じる"
          className="text-gray-400 hover:text-gray-600"
        >
          ×
        </button>
      </div>

      <div className="max-h-[45%] flex-shrink-0 overflow-y-auto border-b border-gray-200">
        {isLoading && <p className="p-3 text-sm text-gray-400">読み込み中...</p>}
        {!isLoading && (history ?? []).length === 0 && (
          <p className="p-3 text-sm text-gray-400">履歴がありません</p>
        )}
        <ul>
          {(history ?? []).map((entry) => (
            <li key={entry.rev}>
              <button
                type="button"
                onClick={() => setSelectedRev(entry.rev)}
                className={`block w-full border-b border-gray-100 px-3 py-2 text-left ${
                  selectedRev === entry.rev ? 'bg-blue-50' : 'hover:bg-gray-100'
                }`}
              >
                <div className="text-sm text-gray-800">{formatDateTime(entry.date)}</div>
                <div className="mt-0.5 truncate text-xs text-gray-500">
                  {entry.authorName} ・ {entry.message}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-shrink-0 border-b border-gray-200">
          <button
            type="button"
            onClick={() => setTab('diff')}
            className={`flex-1 px-3 py-2 text-sm ${
              tab === 'diff' ? 'border-b-2 border-blue-600 font-medium text-blue-600' : 'text-gray-500'
            }`}
          >
            差分
          </button>
          <button
            type="button"
            onClick={() => setTab('content')}
            className={`flex-1 px-3 py-2 text-sm ${
              tab === 'content' ? 'border-b-2 border-blue-600 font-medium text-blue-600' : 'text-gray-500'
            }`}
          >
            内容
          </button>
        </div>

        <div className="flex-1 overflow-auto p-3">
          {tab === 'content' && (
            <pre className="whitespace-pre-wrap text-xs text-gray-800">{content ?? ''}</pre>
          )}
          {tab === 'diff' && (
            <div className="font-mono text-xs">
              {diffLines.map((line, i) => (
                <div key={i} className={DIFF_LINE_CLASS[line.type]}>
                  {line.text || ' '}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex-shrink-0 border-t border-gray-200 p-3">
          <button
            type="button"
            disabled={!selectedRev}
            onClick={() => setRestoreConfirmVisible(true)}
            className="w-full rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            この版に戻す
          </button>
        </div>
      </div>

      {restoreConfirmVisible && (
        <ConfirmDialog
          title="この版に戻す"
          message="現在の内容を破棄してこの版に戻します。よろしいですか?"
          confirmLabel="戻す"
          onConfirm={() => void handleRestore()}
          onCancel={() => setRestoreConfirmVisible(false)}
        />
      )}
    </div>
  );
}
