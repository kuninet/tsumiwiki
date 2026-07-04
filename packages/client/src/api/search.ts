import { useQuery } from '@tanstack/react-query';
import type { DocSummary, SearchResult } from '@tsumiwiki/shared';
import { api } from './client';

// 検索・最近更新API(FR-NAV-03/04・設計04章)

export function useSearch(q: string) {
  const trimmed = q.trim();
  return useQuery({
    queryKey: ['search', trimmed],
    queryFn: async () => {
      const { results } = await api<{ results: SearchResult[] }>(
        'GET',
        `/api/search?q=${encodeURIComponent(trimmed)}`,
      );
      return results;
    },
    enabled: trimmed.length > 0,
  });
}

export function useRecentDocs(limit = 20) {
  return useQuery({
    queryKey: ['recent'],
    queryFn: async () => {
      const { docs } = await api<{ docs: DocSummary[] }>('GET', `/api/docs/recent?limit=${limit}`);
      return docs;
    },
  });
}
