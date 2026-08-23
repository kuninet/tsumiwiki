import path from 'node:path';

// 添付・埋め込み解決で共有する拡張子定義(issue #198)。
// doc-service(アップロード可否)とindexer-service(索引・配信可否)の双方から参照するため
// ここに集約する。indexerはdoc-serviceをimportしない(循環import回避)。

// 添付として受け付ける画像拡張子(アップロード可能。PDF等はFR-IMG-04=COULDで将来)
export const ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
]);

// 配信・索引対象の拡張子とMIME(画像 + PDF)。routes/attachments.tsのraw配信で使う
export const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

// 添付索引(attachment_index)・配信の対象になるファイル名か
// (拡張子を小文字化してMIME_BY_EXTにあるか)
export function isIndexedFileName(name: string): boolean {
  const ext = path.posix.extname(name).toLowerCase();
  return ext in MIME_BY_EXT;
}
