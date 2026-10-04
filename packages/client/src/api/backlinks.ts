import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { BacklinksResponse } from '@tsumiwiki/shared';
import { api } from './client';
import { BACKLINKS_QUERY_KEY, useTree } from './docs';

// バックリンク取得APIクライアント(#267)

export { BACKLINKS_QUERY_KEY };

export function fetchBacklinks(path: string): Promise<BacklinksResponse> {
  return api<BacklinksResponse>('GET', `/api/docs/backlinks?path=${encodeURIComponent(path)}`);
}

export interface UseBacklinksOptions {
  enabled?: boolean;
}

/**
 * 指定文書へのバックリンク一覧を取得するフック。
 * キャッシュ無効化は useTree の dataUpdatedAt に追随する。
 * (treeが無効化・再取得されると新しいクエリキーとなり自動的に最新化される)
 * 再取得時のちらつき防止のため placeholderData: keepPreviousData を適用する。
 */
export function useBacklinks(path: string | undefined, options: UseBacklinksOptions = {}) {
  const treeQuery = useTree();
  const treeDataUpdatedAt = treeQuery.dataUpdatedAt;

  return useQuery({
    queryKey: ['backlinks', path, treeDataUpdatedAt] as const,
    queryFn: () => fetchBacklinks(path!),
    enabled: !!path && (options.enabled ?? true),
    placeholderData: keepPreviousData,
  });
}
