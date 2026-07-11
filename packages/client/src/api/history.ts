import { useQuery } from '@tanstack/react-query';
import type { AllHistoryEntry, HistoryEntry } from '@tsumiwiki/shared';
import { api } from './client';

// 履歴API(FR-HIST・設計04章4.3)

export function historyQueryKey(path: string | undefined) {
  return ['history', path] as const;
}

export function useHistory(path: string | undefined) {
  return useQuery({
    queryKey: historyQueryKey(path),
    queryFn: async () => {
      const { history } = await api<{ history: HistoryEntry[] }>(
        'GET',
        `/api/history?path=${encodeURIComponent(path!)}`,
      );
      return history;
    },
    enabled: !!path,
  });
}

// ライブラリ全体の履歴(issue #66)。単一文書の historyQueryKey('all') と
// react-query のプレフィックスマッチで巻き添え invalidate を起こさないよう、
// キー空間を 'history-all' に分ける
export const ALL_HISTORY_QUERY_KEY = ['history-all'] as const;

export function useAllHistory(enabled: boolean, limit = 100) {
  return useQuery({
    queryKey: [...ALL_HISTORY_QUERY_KEY, limit],
    queryFn: async () => {
      const { history } = await api<{ history: AllHistoryEntry[] }>(
        'GET',
        `/api/history/all?limit=${limit}`,
      );
      return history;
    },
    enabled,
  });
}

// 全体履歴用の差分。rev^..rev の1コミット分の差分を任意パスに対して返す。
// .gitignore・.trash 配下・添付ファイル等の非文書パスも扱えるため、
// 通常の /api/history/diff とは別のルートを使う
export async function fetchHistoryCommitDiff(path: string, rev: string): Promise<string> {
  const { diff } = await api<{ diff: string }>(
    'GET',
    `/api/history/all/diff?path=${encodeURIComponent(path)}&rev=${encodeURIComponent(rev)}`,
  );
  return diff;
}

export async function fetchHistoryContent(path: string, rev: string): Promise<string> {
  const { content } = await api<{ content: string }>(
    'GET',
    `/api/history/content?path=${encodeURIComponent(path)}&rev=${encodeURIComponent(rev)}`,
  );
  return content;
}

export async function fetchHistoryDiff(path: string, rev: string): Promise<string> {
  const { diff } = await api<{ diff: string }>(
    'GET',
    `/api/history/diff?path=${encodeURIComponent(path)}&rev=${encodeURIComponent(rev)}`,
  );
  return diff;
}

export function restoreRevision(path: string, rev: string): Promise<{ updatedAt: string }> {
  return api('POST', '/api/history/restore', { path, rev });
}
