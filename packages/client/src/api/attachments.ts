import { apiErrorSchema } from '@tsumiwiki/shared';

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
