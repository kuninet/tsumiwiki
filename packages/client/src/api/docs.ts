import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateDocRequest,
  CreateFolderRequest,
  DocResponse,
  MoveDocRequest,
  MoveFolderRequest,
  SaveDocRequest,
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

export function docQueryKey(path: string | undefined) {
  return ['doc', path] as const;
}

export interface UseDocOptions {
  // 閲覧中はロック状態の追随のため定期再取得する(設計04章4.3)。編集中はfalseにして上書きを避ける
  refetchInterval?: number | false;
}

export function useDoc(path: string | undefined, options: UseDocOptions = {}) {
  return useQuery({
    queryKey: docQueryKey(path),
    queryFn: () => api<DocResponse>('GET', `/api/docs?path=${encodeURIComponent(path!)}`),
    enabled: !!path,
    refetchInterval: options.refetchInterval,
  });
}

// 文書保存(設計04章4.4)。tree/tags等の一斉invalidateは行わず、
// use-editing-session側で保存文書固有のクエリのみ更新する
export function saveDoc(body: SaveDocRequest): Promise<{ updatedAt: string }> {
  return api('PUT', '/api/docs', body);
}

// 保存競合時、最新のupdatedAtだけを取得し直すための素の関数(設計04章4.4)
export function fetchDoc(path: string): Promise<DocResponse> {
  return api('GET', `/api/docs?path=${encodeURIComponent(path)}`);
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

// 素の移動関数(#72 一括移動用)。個別トースト・invalidateを避けたい場面で使う
export function moveDoc(body: MoveDocRequest): Promise<unknown> {
  return api('POST', '/api/docs/move', body);
}

export function moveFolder(body: MoveFolderRequest): Promise<unknown> {
  return api('POST', '/api/folders/move', body);
}

// #73 一括まとめ用の素の作成関数(useCreateFolderと違い個別トーストを出さない)
export function createFolder(body: CreateFolderRequest): Promise<unknown> {
  return api('POST', '/api/folders', body);
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
