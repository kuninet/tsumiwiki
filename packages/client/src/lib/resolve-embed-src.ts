// Obsidian埋め込み(![[target]])・標準Markdown画像(![](src))の表示解決(FR-OBS-03)
// NodeView側から呼ばれる純関数として切り出し、単体テスト可能にする。
// 解決自体はサーバーの添付索引(attachment_index)が担う(#198)。クライアントは
// /api/embed?target=&from= に1回投げるだけで、旧来の候補総当り(embedSrcCandidates)は廃止した

export interface EmbedTarget {
  file: string;
  width?: number;
  height?: number;
  // `#`以降(`#`自体は含まない)。Obsidianの`#page=3`等をPDF表示にそのまま引き継ぐ用
  anchor?: string;
}

// 埋め込み対象として扱う拡張子集合(embed-view/image-viewで共有し重複定義を避ける)
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
const PDF_EXTENSIONS = new Set(['.pdf']);

function extOf(file: string): string {
  const dot = file.lastIndexOf('.');
  return dot < 0 ? '' : file.slice(dot).toLowerCase();
}

export function isImageFile(file: string): boolean {
  return IMAGE_EXTENSIONS.has(extOf(file));
}

export function isPdfFile(file: string): boolean {
  return PDF_EXTENSIONS.has(extOf(file));
}

// #211: 添付管理メニューの「拡大表示」でも resolved.path から直接URLを組み立てるため公開する
export function toFilesUrl(relPath: string): string {
  return `/api/files/${relPath.split('/').map(encodeURIComponent).join('/')}`;
}

// #199: 添付管理メニュー(embed-view/image-view)でも絶対URLの除外判定に使うため公開する
export function isAbsoluteUrl(value: string): boolean {
  return /^(https?:|data:)/i.test(value);
}

// `![[file|300]]` `![[file|300x200]]` `![[file#anchor]]` `![[file|別名]]` を分解する。
// 最初の`|`より前がfile。fileから`#...`(アンカー)は除去し、anchorとして保持する
// (画像・PDFどちらでも保持。既存呼び出しはanchorを無視するだけなので後方互換)。
// `|`以降は `幅` または `幅x高さ` の形のときだけサイズとして採用し、それ以外(別名指定)は無視する
export function parseEmbedTarget(target: string): EmbedTarget {
  const pipeIdx = target.indexOf('|');
  const rawFile = pipeIdx === -1 ? target : target.slice(0, pipeIdx);
  const hashIdx = rawFile.indexOf('#');
  const file = hashIdx === -1 ? rawFile : rawFile.slice(0, hashIdx);
  const anchor = hashIdx === -1 ? undefined : rawFile.slice(hashIdx + 1);

  if (pipeIdx === -1) return { file, anchor };

  const sizePart = target.slice(pipeIdx + 1);
  const match = /^(\d+)(?:x(\d+))?$/.exec(sizePart);
  if (!match) return { file, anchor };

  const width = Number(match[1]);
  const height = match[2] === undefined ? undefined : Number(match[2]);
  return { file, width, height, anchor };
}

// ![[target]]の解決先URL。実際のファイル解決(名前索引・同フォルダ優先等)はサーバーの
// GET /api/embed?target=&from= が1回で行う。絶対URL(http/https/data)はそのまま返す。
// options.anchorを指定すると末尾に`#<anchor>`を付ける(Obsidianの`#page=3`等をPDF表示に引き継ぐ用。
// `=`や`&`を含む書式をそのまま活かすためencodeURIで最小限のエンコードに留める)
export function embedSrc(file: string, docPath: string, options?: { anchor?: string }): string {
  if (isAbsoluteUrl(file)) return file;
  const base = `/api/embed?target=${encodeURIComponent(file)}&from=${encodeURIComponent(docPath)}`;
  return options?.anchor ? `${base}#${encodeURI(options.anchor)}` : base;
}

// パスセグメント配列から'.'を除去し'..'は1つ上の階層を消費する(posix的な正規化)。
// ルートより上には出ない('..'が余った場合はそのまま無視する)
function normalizeRelSegments(path: string): string {
  const stack: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return stack.join('/');
}

// 標準画像記法 ![alt](src) の解決。絶対URL(http/https/data)はそのまま、
// 相対パスは文書フォルダ基準で結合後に`.`/`..`を正規化して/api/files/...に解決する
export function resolveImageSrc(src: string, docFolder: string): string {
  if (isAbsoluteUrl(src)) return src;
  const joined = docFolder ? `${docFolder}/${src}` : src;
  return toFilesUrl(normalizeRelSegments(joined));
}

// ![](src)がロードに失敗したときのフォールバック: srcのファイル名部分だけを
// embedSrcで解決し直す(添付索引による名前一致に賭ける)。絶対URLはフォールバックしない。
// クエリ・フラグメント(`?`/`#`以降)は除去し、末尾が`/`等でファイル名が空ならnull
export function imageFallbackSrc(src: string, docPath: string): string | null {
  if (isAbsoluteUrl(src)) return null;
  const withoutQueryOrHash = src.split(/[?#]/, 1)[0];
  const segments = withoutQueryOrHash.split('/');
  const basename = segments[segments.length - 1] ?? '';
  if (!basename) return null;
  return embedSrc(basename, docPath);
}
