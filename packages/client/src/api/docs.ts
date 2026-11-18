import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateDocRequest,
  CreateFolderRequest,
  DocResponse,
  MoveDocRequest,
  MoveDocsBatchRequest,
  MoveDocsBatchResponse,
  MovedDocResponse,
  MoveFolderRequest,
  SaveDocRequest,
  SaveDocResponse,
  SkippedAttachment,
  TreeResponse,
} from '@tsumiwiki/shared';
import { type ToastKind, useToastStore } from '../stores/toast';
import { ApiRequestError, api } from './client';
import { ALL_HISTORY_QUERY_KEY } from './history';

export const TREE_QUERY_KEY = ['tree'] as const;
export const TAGS_QUERY_KEY = ['tags'] as const;
export const BACKLINKS_QUERY_KEY = ['backlinks'] as const;

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
export function saveDoc(body: SaveDocRequest): Promise<SaveDocResponse> {
  return api<SaveDocResponse>('PUT', '/api/docs', body);
}

// 保存競合時、最新のupdatedAtだけを取得し直すための素の関数(設計04章4.4)
export function fetchDoc(path: string): Promise<DocResponse> {
  return api('GET', `/api/docs?path=${encodeURIComponent(path)}`);
}

// 文書・フォルダの変更系mutation共通処理: 成功時にtree/tagsを更新し結果をトースト表示する
function useLibraryMutation<TVariables, TData = unknown>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  successMessage: string,
) {
  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);
  return useMutation<TData, Error, TVariables>({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ALL_HISTORY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: BACKLINKS_QUERY_KEY });
      showToast('success', successMessage);
    },
    onError: (err) => {
      showToast('error', err instanceof ApiRequestError ? err.message : '操作に失敗しました');
    },
  });
}

export interface CreateDocResponse {
  path: string;
  updatedAt: string;
}

export function useCreateDoc() {
  return useLibraryMutation<CreateDocRequest, CreateDocResponse>(
    (body: CreateDocRequest) => api<CreateDocResponse>('POST', '/api/docs', body),
    '文書を作成しました',
  );
}

export function useDeleteDoc() {
  return useLibraryMutation(
    (path: string) => api('DELETE', `/api/docs?path=${encodeURIComponent(path)}`),
    '文書を削除しました',
  );
}

// 移動系のレスポンスは正規化後の新パス。sanitizeTitle 等でサーバー側で名前が変わる
// ケースがあるため、rename の追従はクライアントで組み立てず必ずこの path を使う
export type MovedResponse = MovedDocResponse;

// #334: 共有・同名衝突で元のフォルダに残した添付がある場合、1つのトーストへ統合して通知する
export function formatMoveToastMessage(
  baseMessage: string,
  skippedAttachments?: SkippedAttachment[],
): { kind: ToastKind; message: string } {
  if (!skippedAttachments || skippedAttachments.length === 0) {
    return { kind: 'success', message: baseMessage };
  }
  const sharedCount = skippedAttachments.filter((a) => a.reason === 'shared').length;
  const conflictCount = skippedAttachments.filter((a) => a.reason === 'conflict').length;
  const notes: string[] = [];
  if (sharedCount > 0) {
    notes.push(`共有中の添付 ${sharedCount} 件は元のフォルダに残しました`);
  }
  if (conflictCount > 0) {
    notes.push(`移動先に同名ファイルがあるため添付 ${conflictCount} 件は元のフォルダに残しました`);
  }
  if (notes.length === 0) {
    return { kind: 'success', message: baseMessage };
  }
  return { kind: 'info', message: `${baseMessage}（${notes.join('・')}）` };
}

export function useMoveDoc() {
  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);
  return useMutation<MovedResponse, Error, MoveDocRequest>({
    mutationFn: (body: MoveDocRequest) => api<MovedResponse>('POST', '/api/docs/move', body),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ALL_HISTORY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: BACKLINKS_QUERY_KEY });
      const formatted = formatMoveToastMessage('文書を移動しました', data.skippedAttachments);
      showToast(formatted.kind, formatted.message);
    },
    onError: (err) => {
      showToast('error', err instanceof ApiRequestError ? err.message : '操作に失敗しました');
    },
  });
}

// 素の移動関数(#72 / #334 一括移動用)。個別トースト・invalidateを避けたい場面で使う
export function moveDoc(body: MoveDocRequest): Promise<MovedResponse> {
  return api<MovedResponse>('POST', '/api/docs/move', body);
}

export function moveDocsBatch(body: MoveDocsBatchRequest): Promise<MoveDocsBatchResponse> {
  return api<MoveDocsBatchResponse>('POST', '/api/docs/move-batch', body);
}

export function moveFolder(body: MoveFolderRequest): Promise<MovedResponse> {
  return api<MovedResponse>('POST', '/api/folders/move', body);
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
    (body: MoveFolderRequest) => api<MovedResponse>('POST', '/api/folders/move', body),
    'フォルダを移動しました',
  );
}

export function useDeleteFolder() {
  return useLibraryMutation(
    (path: string) => api('DELETE', `/api/folders?path=${encodeURIComponent(path)}`),
    'フォルダを削除しました',
  );
}
