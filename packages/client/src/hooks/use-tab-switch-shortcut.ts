import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { docUrl } from '../lib/doc-path';
import {
  getActivePaneActiveIdFromState,
  getActivePaneTabsFromState,
  useTabsStore,
} from '../stores/tabs';

// Phase D(#139): Ctrl+Tab / Ctrl+Shift+Tab で活性ペイン内のタブを循環切替。
// - 単一ペイン運用時は元々ある IME/DevTools 系ショートカットと衝突しないので安全
// - Ctrl+Tab は Chrome の 「隣のブラウザタブへ」と重なる。preventDefault は best-effort
//   だが、多くの環境でブラウザ側に取られる。効かない環境では諦める(#145 参照)

export function useTabSwitchShortcut() {
  const navigate = useNavigate();
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.isComposing) return;
      if (!e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'Tab') return;
      const activePath = getActivePaneActiveIdFromState(useTabsStore.getState());
      const tabs = getActivePaneTabsFromState(useTabsStore.getState());
      if (tabs.length === 0) return;
      const idx = activePath ? tabs.findIndex((t) => t.path === activePath) : -1;
      if (idx === -1) return;
      const step = e.shiftKey ? -1 : 1;
      const nextIdx = (idx + step + tabs.length) % tabs.length;
      const nextPath = tabs[nextIdx].path;
      if (nextPath === activePath) return;
      e.preventDefault();
      useTabsStore.getState().setActive(nextPath);
      navigate(docUrl(nextPath));
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);
}
