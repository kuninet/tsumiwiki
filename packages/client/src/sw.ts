/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

// Service Worker本体(設計07章7.6・#251)。
//
// 戦略:
//   app shell(Viteのビルド成果物) … プリキャッシュ(self.__WB_MANIFESTを使い、手書きの一覧は持たない)
//   ナビゲーション                 … ネットワーク優先、失敗時はプリキャッシュしたindex.htmlを返す
//   /api/*                        … キャッシュしない。ネットワークへ素通し(ルートを登録しない)
//
// /api/* をキャッシュしない理由: 文書データのオフライン提供はIndexedDBの責務(#253)であり、
// Service Workerが古いAPIレスポンスを返すとログイン状態や認可の判定が壊れる。
// 401/403をキャッシュしたり、キャッシュで肩代わりしたりしてはならない。

declare const self: ServiceWorkerGlobalScope & {
  // vite-plugin-pwa(workbox)がビルド時に差し込むプリキャッシュ対象の一覧
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// プリキャッシュ。過去のデプロイで作られた古いプリキャッシュは破棄する。
// これにより再デプロイ後に古いアセットを掴んだままにならない
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ナビゲーションフォールバックの除外パス。
// サーバー側のSPAフォールバック(packages/server/src/app.ts の setNotFoundHandler)と
// 同じものを除外し、オンライン/オフラインで挙動を揃える
const NAVIGATION_DENYLIST = [
  // API(素通し。SWが肩代わりしない)
  /^\/api\//i,
  // Remote MCPエンドポイント(MCPクライアントにHTMLを返さない)
  /^\/mcp(?:\/|$)/i,
];

// ナビゲーション: ネットワーク優先。オフライン等で失敗したときだけ
// プリキャッシュ済みのindex.htmlを返し、SPAを起動させる
async function handleNavigation({ request }: { request: Request }): Promise<Response> {
  try {
    return await fetch(request);
  } catch {
    const cached = await matchPrecache('/index.html');
    // index.htmlが取れないとき(初回訪問がオフライン等)はネットワークエラーのまま返す
    return cached ?? Response.error();
  }
}

registerRoute(new NavigationRoute(handleNavigation, { denylist: NAVIGATION_DENYLIST }));

// NOTE: 添付(/api/files/* ・ /api/embed)のキャッシュ優先+LRUは #256 の範囲。
// 差し込むならこの位置に registerRoute(/^\/api\/(files|embed)/, ...) を追加する。
// それ以外の /api/* は今後もルートを登録せず素通しのままにすること(設計07章7.6)。

// ユーザーが更新を承諾したときだけ待機中のSWを有効化する(即時のskipWaitingはしない)。
// 編集中のタブが無警告で置き換わるのを避けるため(設計07章7.6)
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

// 初回インストール時に既存のタブを即座に制御下へ置く。
// 更新時はユーザーがskipWaitingを承諾するまでactivateされないため、無警告の置き換えは起きない
clientsClaim();
