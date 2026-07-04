import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TrashEntry } from '@tsumiwiki/shared';
import { ApiRequestError, api } from './client';
import { TAGS_QUERY_KEY, TREE_QUERY_KEY } from './docs';
import { useToastStore } from '../stores/toast';

// ごみ箱API(FR-DOC-07・設計04章4.3)

export const TRASH_QUERY_KEY = ['trash'] as const;

export function useTrash() {
  return useQuery({
    queryKey: TRASH_QUERY_KEY,
    queryFn: async () => {
      const { entries } = await api<{ entries: TrashEntry[] }>('GET', '/api/trash');
      return entries;
    },
  });
}

// 復元・完全削除の共通処理: 成功時にtrash/tree/tagsを更新しトースト表示する
function useTrashMutation<TVariables>(
  mutationFn: (variables: TVariables) => Promise<unknown>,
  successMessage: string,
) {
  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);
  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY });
      showToast('success', successMessage);
    },
    onError: (err) => {
      showToast('error', err instanceof ApiRequestError ? err.message : '操作に失敗しました');
    },
  });
}

export function useRestoreTrash() {
  return useTrashMutation(
    (trashPath: string) => api('POST', '/api/trash/restore', { trashPath }),
    '復元しました',
  );
}

export function usePurgeTrash() {
  return useTrashMutation(
    (trashPath: string) => api('DELETE', `/api/trash?path=${encodeURIComponent(trashPath)}`),
    '完全に削除しました',
  );
}
