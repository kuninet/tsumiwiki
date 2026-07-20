// 文書パスから/doc/*・/history/*ルートへのURLを組み立てる。
// パスは'/'区切りだがセグメント自体に'#'や'?'等を含みうるため、
// セグメントごとにencodeURIComponentしないとnavigate先でハッシュ/クエリとして
// 誤解釈され、useParams()['*']が本来のパスの手前で切れてしまう

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function docUrl(path: string): string {
  return `/doc/${encodePath(path)}`;
}

export function historyUrl(path: string): string {
  return `/history/${encodePath(path)}`;
}

// パス末尾のファイル名から拡張子を落として「表示用タイトル」を得る。
// TabBar・DocView など複数箇所で同じ演算をしていたので集約する
export function titleFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}
