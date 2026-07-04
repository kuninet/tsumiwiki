import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateDocRequest,
  CreateFolderRequest,
  DocResponse,
  MoveDocRequest,
  MoveFolderRequest,
  TreeResponse,
} from '@tsumiwiki/shared';
import { useToastStore } from '../stores/toast';
import { ApiRequestError, api } from './client';

export const TREE_QUERY_KEY = ['tree'] as const;
export const TAGS_QUERY_KEY = ['tags'] as const;

export function useTree() {
  return useQuery({
    queryKey: TREE_QUERY_KEY,
    queryFn: () => api<TreeResponse>('GET', '/api/tree'),
  });
}

export function useDoc(path: string | undefined) {
  return useQuery({
    queryKey: ['doc', path],
    queryFn: () => api<DocResponse>('GET', `/api/docs?path=${encodeURIComponent(path!)}`),
    enabled: !!path,
  });
}

// 文書・フォルダの変更系mutation共通処理: 成功時にtree/tagsを更新し結果をトースト表示する
function useLibraryMutation<TVariables>(
  mutationFn: (variables: TVariables) => Promise<unknown>,
  successMessage: string,
) {
  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);
  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY });
      showToast('success', successMessage);
    },
    onError: (err) => {
      showToast('error', err instanceof ApiRequestError ? err.message : '操作に失敗しました');
    },
  });
}

export function useCreateDoc() {
  return useLibraryMutation(
    (body: CreateDocRequest) => api('POST', '/api/docs', body),
    '文書を作成しました',
  );
}

export function useDeleteDoc() {
  return useLibraryMutation(
    (path: string) => api('DELETE', `/api/docs?path=${encodeURIComponent(path)}`),
    '文書を削除しました',
  );
}

export function useMoveDoc() {
  return useLibraryMutation(
    (body: MoveDocRequest) => api('POST', '/api/docs/move', body),
    '文書を移動しました',
  );
}

export function useCreateFolder() {
  return useLibraryMutation(
    (body: CreateFolderRequest) => api('POST', '/api/folders', body),
    'フォルダを作成しました',
  );
}

export function useMoveFolder() {
  return useLibraryMutation(
    (body: MoveFolderRequest) => api('POST', '/api/folders/move', body),
    'フォルダを移動しました',
  );
}

export function useDeleteFolder() {
  return useLibraryMutation(
    (path: string) => api('DELETE', `/api/folders?path=${encodeURIComponent(path)}`),
    'フォルダを削除しました',
  );
}
