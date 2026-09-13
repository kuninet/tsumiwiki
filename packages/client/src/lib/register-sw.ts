// Service Workerの登録と更新検知(設計07章7.6・#251)。
//
// 更新は即時に適用しない。新しいSWがwaitingになったらonUpdateReadyで呼び出し側に知らせ、
// ユーザーが承諾したときだけskipWaitingを促してリロードする。
// 編集中のタブが無警告で置き換わるのを避けるため。

/** 更新を適用する関数。ユーザーが「再読み込み」を選んだときに呼ぶ */
export type ApplyUpdate = () => void;

/**
 * `/sw.js` を登録し、更新が用意できたらonUpdateReadyを呼ぶ。
 *
 * 開発時(vite dev)はService Workerを生成していないため、呼び出し側で
 * `import.meta.env.PROD` を判定してから呼ぶこと(HMRを妨げないため)。
 */
export function registerServiceWorker(onUpdateReady: (applyUpdate: ApplyUpdate) => void): void {
  if (!('serviceWorker' in navigator)) return;
  const container = navigator.serviceWorker;

  // ユーザーが更新を承諾したかどうか。承諾なしのcontrollerchange(初回インストール時の
  // clientsClaim)でリロードしてしまわないようにするためのフラグ
  let updateAccepted = false;

  container.addEventListener('controllerchange', () => {
    if (!updateAccepted) return;
    updateAccepted = false; // 二重リロードの防止
    window.location.reload();
  });

  function notify(worker: ServiceWorker) {
    onUpdateReady(() => {
      updateAccepted = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    });
  }

  container
    .register('/sw.js', { scope: '/' })
    .then((registration) => {
      // 既に新しいSWが待機している場合(前回の訪問で更新を見送ったケース)
      if (registration.waiting && container.controller) {
        notify(registration.waiting);
        return;
      }
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // controllerが居ないときは初回インストール。通知は出さない
          if (installing.state === 'installed' && container.controller) {
            notify(installing);
          }
        });
      });
    })
    .catch((err: unknown) => {
      // 登録失敗はオフライン対応が効かないだけでアプリ自体は動くため、ログに留める
      console.error('Service Workerの登録に失敗しました', err);
    });
}
