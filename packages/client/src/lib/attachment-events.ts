// #199 添付の削除/リネーム後、既に画面に表示中のNodeView(embed-view/image-view)に
// 「この添付(basename)は実体が変わったので表示を再取得してほしい」と伝えるイベント。
//
// ブラウザは一度読み込みに成功した<img src>を(同じURLである限り)再取得しないため、
// 削除直後もエディタ上に古い画像が残り続けてしまう不具合が実機確認で見つかった
// (リネームは対象ノードのsrc/target自体が新パスに変わるため自然に再取得されるが、
// 削除や、リネーム後も残る「他の開いているタブ・ペインに表示中の同名添付」は
// srcが変化しないため、明示的なトリガーが要る)。
//
// DocView側(削除/リネーム成功時)がdispatchAttachmentChangedを呼び、
// embed-view.tsx/image-view.tsxがwindowイベントを購読してbasenameが一致したら
// クエリ文字列にキャッシュバスターを付けて再取得し、失敗状態もリセットする。

export const ATTACHMENT_CHANGED_EVENT = 'tsumiwiki:attachment-changed';

export interface AttachmentChangedDetail {
  // 実体が変わった添付のbasename一覧(削除ならその名前、リネームなら旧名)
  names: string[];
}

// #199軽微4: 再取得用のキャッシュバスター番号(reloadKey)をNodeViewのローカルstateだけに
// 持たせると、タブ切替等でNodeViewが再マウントされたときに`v=`が失われる。再マウント後の
// 初回レンダーでも同じ(またはそれ以上の)番号を付けられるよう、basename単位の世代カウンタを
// モジュールスコープで保持する(ページを離れずSPA内で戻ってきた場合のみ有効。フルリロード後は
// HTTPキャッシュのmax-ageが切れていれば問題にならない)
const generationByName = new Map<string, number>();

export function getAttachmentGeneration(name: string): number {
  return generationByName.get(name.toLowerCase()) ?? 0;
}

// テスト用: モジュールスコープの世代カウンタをリセットする(他テストの影響を受けないように)
export function resetAttachmentGenerations(): void {
  generationByName.clear();
}

export function dispatchAttachmentChanged(names: string[]): void {
  if (names.length === 0) return;
  for (const name of names) {
    const key = name.toLowerCase();
    generationByName.set(key, (generationByName.get(key) ?? 0) + 1);
  }
  window.dispatchEvent(
    new CustomEvent<AttachmentChangedDetail>(ATTACHMENT_CHANGED_EVENT, { detail: { names } }),
  );
}

// URLにキャッシュバスターを付与する。既にクエリ文字列があれば`&`、無ければ`?`で連結する
// (/api/embedは既にtarget=&from=を持つため`&v=`、/api/filesは持たないため`?v=`になる)
export function withCacheBuster(url: string, version: number): string {
  if (version === 0) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${version}`;
}
