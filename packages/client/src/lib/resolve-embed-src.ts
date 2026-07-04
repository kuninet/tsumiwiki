// Obsidian埋め込み(![[target]])・標準Markdown画像(![](src))の表示解決(FR-OBS-03)
// NodeView側から呼ばれる純関数として切り出し、単体テスト可能にする

function toFilesUrl(relPath: string): string {
  return `/api/files/${relPath.split('/').map(encodeURIComponent).join('/')}`;
}

function isAbsoluteUrl(value: string): boolean {
  return /^(https?:|data:)/i.test(value);
}

// ![[target]]の解決候補を優先順で返す(①文書と同じフォルダ ②ルート ③attachments/)。
// 実際の存在確認はNodeView側のonErrorで候補を順に試すことで行う
export function embedSrcCandidates(target: string, docFolder: string): string[] {
  if (isAbsoluteUrl(target)) return [target];

  const relPaths = [docFolder ? `${docFolder}/${target}` : target, target, `attachments/${target}`];
  return [...new Set(relPaths)].map(toFilesUrl);
}

// 標準画像記法 ![alt](src) の解決。絶対URL(http/https/data)はそのまま、
// 相対パスは文書フォルダ基準で/api/files/...に解決する
export function resolveImageSrc(src: string, docFolder: string): string {
  if (isAbsoluteUrl(src)) return src;
  const joined = docFolder ? `${docFolder}/${src}` : src;
  return toFilesUrl(joined);
}
