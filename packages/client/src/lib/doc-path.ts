// 文書パスから/doc/*ルートへのURLを組み立てる。
// パスは'/'区切りだがセグメント自体に'#'や'?'等を含みうるため、
// セグメントごとにencodeURIComponentしないとnavigate先でハッシュ/クエリとして
// 誤解釈され、useParams()['*']が本来のパスの手前で切れてしまう

export function docUrl(path: string): string {
  return `/doc/${path.split('/').map(encodeURIComponent).join('/')}`;
}
