import { useEffect } from 'react';
import { getActivePaneActiveIdFromState, useTabsStore } from '../stores/tabs';
import { useUIStore } from '../stores/ui';

// Phase C-1 (#137): Ctrl+N(Mac: ⌘N)で新規文書作成モーダルを起動する。
//
// 初期フォルダはアクティブタブの文書と同じフォルダ(#138 の same-folder ポリシー相当)。
// Phase C-2 で「same-folder / fixed-folder / root」の切替設定が入る予定なので、
// ここではひとまず同一フォルダ既定で実装する。
//
// preventDefault は多くのブラウザで無効(Chrome の Ctrl+N は新規ウィンドウ)。
// 「試すだけ試す」実装で、ブラウザ側のショートカットが優先されるのは受容する。

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

function folderOfPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
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
      // アクティブタブがあればそのフォルダ、無ければルート
      const activePath = getActivePaneActiveIdFromState(useTabsStore.getState());
      const initialFolder = activePath ? folderOfPath(activePath) : '';
      useUIStore.getState().requestCreateDoc(initialFolder);
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
