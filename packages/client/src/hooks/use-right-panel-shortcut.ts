import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { isMainRoute, useRightPanelActions } from './use-right-panel';

// #271: Ctrl/Cmd+Shift+U で右パネルを開閉するグローバルショートカット(D2, D3)
export function useRightPanelShortcut() {
  const location = useLocation();
  const { toggleRightPanel } = useRightPanelActions();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.isComposing) return;
      if (!isMainRoute(location.pathname)) return;

      const hasMod = e.ctrlKey || e.metaKey;
      if (hasMod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'u') {
        e.preventDefault();
        toggleRightPanel();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [location.pathname, toggleRightPanel]);
}
