import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiErrorSchema } from '@tsumiwiki/shared';
import type {
  AttachmentReferencesResponse,
  RenameAttachmentRequest,
  RenameAttachmentResponse,
  ReorganizeAttachmentsRequest,
  ReorganizeExecuteResponse,
  ReorganizePreviewResponse,
  ResolveAttachmentResponse,
} from '@tsumiwiki/shared';
import { dispatchAttachmentChanged } from '../lib/attachment-events';
import { useToastStore } from '../stores/toast';
import { ApiRequestError, api } from './client';
import { BACKLINKS_QUERY_KEY, TREE_QUERY_KEY, docQueryKey } from './docs';
import { ALL_HISTORY_QUERY_KEY } from './history';

// 画像・PDF添付のアップロード(FR-IMG-01/02/04)。multipart/form-dataのためapi()は使わず素で実装する
// (api()はContent-Type: application/jsonを常に付与するため、boundary付きヘッダを
// ブラウザに委ねる必要のあるmultipart送信とは相性が悪い)

export interface AttachmentResult {
  fileName: string;
  path: string;
  embedTarget?: string;
}

export async function uploadAttachment(docPath: string, file: File): Promise<AttachmentResult> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`/api/attachments?docPath=${encodeURIComponent(docPath)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'TsumiWiki' },
    body: formData,
  });

  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(await res.json().catch(() => null));
    throw new Error(parsed.success ? parsed.data.error.message : 'アップロードに失敗しました');
  }
  return (await res.json()) as AttachmentResult;
}

// 添付ファイルの管理(FR-IMG-05・#199)。解決規則は/api/embedと共通(IndexerService.resolveAttachment)

export function resolveAttachment(target: string, from: string): Promise<ResolveAttachmentResponse> {
  return api(
    'GET',
    `/api/attachments/resolve?target=${encodeURIComponent(target)}&from=${encodeURIComponent(from)}`,
  );
}

export function fetchAttachmentReferences(path: string): Promise<AttachmentReferencesResponse> {
  return api('GET', `/api/attachments/references?path=${encodeURIComponent(path)}`);
}

export function renameAttachment(body: RenameAttachmentRequest): Promise<RenameAttachmentResponse> {
  return api('POST', '/api/attachments/rename', body);
}

export async function deleteAttachment(path: string): Promise<void> {
  await api('DELETE', `/api/attachments?path=${encodeURIComponent(path)}`);
}

// #333: 既存添付ファイルの一括整理・移行
export function previewReorganizeAttachments(
  body: ReorganizeAttachmentsRequest,
): Promise<ReorganizePreviewResponse> {
  return api('POST', '/api/attachments/reorganize/preview', body);
}

export function reorganizeAttachments(
  body: ReorganizeAttachmentsRequest,
): Promise<ReorganizeExecuteResponse> {
  return api('POST', '/api/attachments/reorganize', body);
}

export function useReorganizeAttachments() {
  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);
  return useMutation({
    mutationFn: (body: ReorganizeAttachmentsRequest) => reorganizeAttachments(body),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ALL_HISTORY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: BACKLINKS_QUERY_KEY });
      for (const d of res.rewrittenDocs) {
        queryClient.invalidateQueries({ queryKey: docQueryKey(d.path) });
      }
      const changedNames = new Set<string>();
      for (const m of res.moved) {
        const oldBase = m.fromPath.split('/').pop();
        const newBase = m.toPath.split('/').pop();
        if (oldBase) changedNames.add(oldBase);
        if (newBase) changedNames.add(newBase);
      }
      if (changedNames.size > 0) {
        dispatchAttachmentChanged([...changedNames]);
      }
      showToast(
        'success',
        res.moved.length === 0
          ? '移動対象の添付ファイルはありませんでした'
          : `添付ファイルを ${res.moved.length} 件整理しました（文書更新 ${res.rewrittenDocs.length} 件）`,
      );
    },
    onError: (err) => {
      showToast(
        'error',
        err instanceof ApiRequestError ? err.message : '添付ファイルの整理に失敗しました',
      );
    },
  });
}
