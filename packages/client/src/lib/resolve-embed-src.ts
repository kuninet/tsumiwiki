// Obsidian埋め込み(![[target]])・標準Markdown画像(![](src))の表示解決(FR-OBS-03)
// NodeView側から呼ばれる純関数として切り出し、単体テスト可能にする。
// 解決自体はサーバーの添付索引(attachment_index)が担う(#198)。クライアントは
// /api/embed?target=&from= に1回投げるだけで、旧来の候補総当り(embedSrcCandidates)は廃止した

export interface EmbedTarget {
  file: string;
  width?: number;
  height?: number;
}

function toFilesUrl(relPath: string): string {
  return `/api/files/${relPath.split('/').map(encodeURIComponent).join('/')}`;
}

function isAbsoluteUrl(value: string): boolean {
  return /^(https?:|data:)/i.test(value);
}

// `![[file|300]]` `![[file|300x200]]` `![[file#anchor]]` `![[file|別名]]` を分解する。
// 最初の`|`より前がfile。fileから`#...`(アンカー)は除去する。
// `|`以降は `幅` または `幅x高さ` の形のときだけサイズとして採用し、それ以外(別名指定)は無視する
export function parseEmbedTarget(target: string): EmbedTarget {
  const pipeIdx = target.indexOf('|');
  const rawFile = pipeIdx === -1 ? target : target.slice(0, pipeIdx);
  const hashIdx = rawFile.indexOf('#');
  const file = hashIdx === -1 ? rawFile : rawFile.slice(0, hashIdx);

  if (pipeIdx === -1) return { file };

  const sizePart = target.slice(pipeIdx + 1);
  const match = /^(\d+)(?:x(\d+))?$/.exec(sizePart);
  if (!match) return { file };

  const width = Number(match[1]);
  return match[2] === undefined ? { file, width } : { file, width, height: Number(match[2]) };
}

// ![[target]]の解決先URL。実際のファイル解決(名前索引・同フォルダ優先等)はサーバーの
// GET /api/embed?target=&from= が1回で行う。絶対URL(http/https/data)はそのまま返す
export function embedSrc(file: string, docPath: string): string {
  if (isAbsoluteUrl(file)) return file;
  return `/api/embed?target=${encodeURIComponent(file)}&from=${encodeURIComponent(docPath)}`;
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
