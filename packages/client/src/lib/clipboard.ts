import type { ToastKind } from '../stores/toast';

// クリップボードへ文字列を書き込む共通関数(#301)。
// 1. textarea + copy イベント + execCommand('copy') の同期経路を最優先する。
//    Safari は async Clipboard API が成功扱いでも実際は書けないことがあり(#238)、
//    非セキュアコンテキスト(LAN の http)では navigator.clipboard 自体が無いため。
// 2. 同期経路が使えなければ navigator.clipboard.writeText を試す。
// 3. どちらも無理なら false。
// ユーザージェスチャ内で execCommand を走らせるため、async 関数にはしない。
// 呼び出し側も await の後に呼ばず、クリックハンドラの中で直接呼ぶこと。
export function copyText(text: string): Promise<boolean> {
  if (copyViaExecCommand(text)) return Promise.resolve(true);
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) return Promise.resolve(false);
  try {
    return clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

// copyText の結果をトーストで知らせる。失敗時の文言は常に「コピーに失敗しました」
export function copyTextWithToast(
  text: string,
  showToast: (kind: ToastKind, message: string) => void,
  successMessage = 'パスをコピーしました',
): void {
  void copyText(text).then((ok) => {
    if (ok) showToast('success', successMessage);
    else showToast('error', 'コピーに失敗しました');
  });
}

function copyViaExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  let handled = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', text);
    handled = true;
  };
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0;';
  document.body.appendChild(textarea);
  document.addEventListener('copy', onCopy, true);
  try {
    textarea.select();
    // iOS/iPadOS Safari は select() だけでは選択が入らないことがある(定番の回避策)
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand('copy') && handled;
  } catch {
    return false;
  } finally {
    document.removeEventListener('copy', onCopy, true);
    textarea.remove();
  }
}
