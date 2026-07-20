import { useEffect } from 'react';
import { getActivePaneActiveIdFromState, useTabsStore } from '../stores/tabs';
import { useUIStore } from '../stores/ui';
import { resolveNewDocInitialFolder } from '../stores/user-settings';

// Phase C-1 (#137) + C-2 (#138): Ctrl+N(Mac: ⌘N)で新規文書作成モーダルを起動する。
//
// 初期フォルダは userSettings.newDocPolicy に従って解決する:
// - same-folder: アクティブタブと同じフォルダ(既定)
// - fixed-folder: 設定した固定フォルダ
// - root: 常にルート
//
// preventDefault は多くのブラウザで無効(Chrome の Ctrl+N は新規ウィンドウ)。
// 「試すだけ試す」実装で、ブラウザ側のショートカットが優先されるのは受容する。

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

export function useNewDocShortcut() {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // IME 変換中は無視(誤発火防止)
      if (e.isComposing) return;
      const modOk = isMac() ? e.metaKey : e.ctrlKey;
      if (!(modOk && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n')) return;
      // ブラウザデフォルト抑止(効かない環境もある)
      e.preventDefault();
      const activePath = getActivePaneActiveIdFromState(useTabsStore.getState());
      const initialFolder = resolveNewDocInitialFolder(activePath);
      useUIStore.getState().requestCreateDoc(initialFolder);
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
