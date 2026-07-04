import { useQuery } from '@tanstack/react-query';
import type { HistoryEntry } from '@tsumiwiki/shared';
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
