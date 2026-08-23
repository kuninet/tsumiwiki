import { apiErrorSchema } from '@tsumiwiki/shared';
import type {
  AttachmentReferencesResponse,
  RenameAttachmentRequest,
  RenameAttachmentResponse,
  ResolveAttachmentResponse,
} from '@tsumiwiki/shared';
import { api } from './client';

// 画像添付のアップロード(FR-IMG-01/02)。multipart/form-dataのためapi()は使わず素で実装する
// (api()はContent-Type: application/jsonを常に付与するため、boundary付きヘッダを
// ブラウザに委ねる必要のあるmultipart送信とは相性が悪い)

export interface AttachmentResult {
  fileName: string;
  path: string;
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
