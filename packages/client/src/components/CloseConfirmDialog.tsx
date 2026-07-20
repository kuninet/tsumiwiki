import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { docUrl, titleFromPath } from '../lib/doc-path';
import { getTabActions } from '../lib/tab-actions-registry';
import { getActivePaneActiveIdFromState, useTabsStore } from '../stores/tabs';
import { useToastStore } from '../stores/toast';

// Phase A-2: dirty なタブを閉じるときに表示する 3ボタン(保存/破棄/キャンセル)ダイアログ。
// MainPage 直下に常駐し、tabs.pendingClose が非 null のときのみ描画する。
// save/discard は tab-actions-registry 経由で該当 path の DocView に委譲する。

export function CloseConfirmDialog() {
  const pendingClose = useTabsStore((s) => s.pendingClose);
  const closeTab = useTabsStore((s) => s.closeTab);
  const cancelClose = useTabsStore((s) => s.cancelClose);
  const showToast = useToastStore((s) => s.show);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  if (!pendingClose) return null;

  const path = pendingClose.path;

  // 走行中の非同期操作が終わったあと、pendingClose が別 path に置き換わっていた
  // ときに新しい方を消してしまわないよう、対象 path が今も pending であるときだけ
  // clearClose する(M4 対応)
  function clearCloseIfStillMe(targetPath: string) {
    if (useTabsStore.getState().pendingClose?.path === targetPath) cancelClose();
  }

  // 閉じた後に URL を新 activeId(or /)へ追随させる。
  // Phase B: activePane の activeId を参照する
  function navigateToActive() {
    const activeId = getActivePaneActiveIdFromState(useTabsStore.getState());
    const desired = activeId ? docUrl(activeId) : '/';
    if (window.location.pathname !== desired) navigate(desired);
  }

  async function handleSave() {
    if (busy) return;
    setBusy(true);
    try {
      const actions = getTabActions(path);
      if (!actions) {
        // 何らかの理由で登録が消えている(edit セッション終了直後など)場合は
        // 単に閉じる。dirty のままなら flushOnLeave が draft を保存してくれる
        closeTab(path);
        clearCloseIfStillMe(path);
        navigateToActive();
        return;
      }
      // save の戻り値で成否を判定する。tabs store の dirty(onDirtyChange 経由の
      // React state 反映)を await 直後に見ると常に stale なので使ってはいけない(R1)
      const ok = await actions.save();
      if (ok) {
        closeTab(path);
        clearCloseIfStillMe(path);
        navigateToActive();
      } else {
        // session.save() 側で個別エラー(競合/失敗)のトーストは既に出ている
        showToast('error', '保存できなかったのでタブを開いたままにしました');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleDiscard() {
    if (busy) return;
    setBusy(true);
    try {
      const actions = getTabActions(path);
      if (actions) {
        // 編集をキャンセル(下書き削除 + ロック解放)してから閉じる。
        // 呼ばないと flushOnLeave が draft を書き戻してしまう
        await actions.discard();
      }
      closeTab(path);
      clearCloseIfStillMe(path);
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    if (busy) return;
    cancelClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="close-confirm-title"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <div className="w-96 rounded-lg border border-line bg-panel p-6 shadow-lg">
        <h2 id="close-confirm-title" className="mb-2 text-base font-bold text-ink">
          未保存の変更があります
        </h2>
        <p className="text-sm text-ink-soft">
          「{titleFromPath(path)}」には未保存の変更があります。閉じる前に保存しますか?
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={handleCancel}
            disabled={busy}
            className="rounded border border-line px-3 py-1.5 text-sm text-ink-soft hover:bg-hoverbg disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleDiscard}
            disabled={busy}
            className="rounded border border-line px-3 py-1.5 text-sm text-danger hover:bg-hoverbg disabled:opacity-50"
          >
            破棄して閉じる
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy}
            aria-busy={busy}
            className="rounded bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
          >
            保存して閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
