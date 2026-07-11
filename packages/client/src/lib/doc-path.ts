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
