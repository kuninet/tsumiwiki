import { useQueryClient } from '@tanstack/react-query';
import { Menu, RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { TAGS_QUERY_KEY, TREE_QUERY_KEY } from '../api/docs';
import { useMediaQuery } from '../hooks/use-media-query';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { useUIStore } from '../stores/ui';
import { SearchBox } from './SearchBox';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

// ヘッダー(components.md仕様)。高さ52px・bg-panel・border-b

export function Header() {
  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useMediaQuery('(max-width: 767px)');
  const toggleSidebarCollapsed = useUIStore((s) => s.toggleSidebarCollapsed);

  // Ctrl/Cmd+Kで検索ボックスへフォーカス(編集モード中はDocView側のリンクダイアログを優先する)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k') return;
      if (useEditStore.getState().mode === 'edit') return;
      e.preventDefault();
      searchInputRef.current?.focus();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  async function handleRescan() {
    try {
      await api('POST', '/api/library/rescan');
      queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY });
      showToast('success', '更新を確認しました');
    } catch {
      showToast('error', '更新確認に失敗しました');
    }
  }

  return (
    <header className="flex h-[52px] flex-shrink-0 items-center gap-2 border-b border-line bg-panel px-2 md:gap-4 md:px-4">
      {isMobile && (
        <button
          type="button"
          onClick={toggleSidebarCollapsed}
          aria-label="サイドバーを開く"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded text-ink-soft hover:bg-hoverbg"
        >
          <Menu size={18} aria-hidden="true" />
        </button>
      )}
      <Link to="/" aria-label="TsumiWiki (ホーム)" className="flex flex-shrink-0 items-center gap-2">
        <span
          aria-hidden="true"
          style={{ background: 'var(--tw-accent-gradient)' }}
          className="flex h-[26px] w-[26px] items-center justify-center rounded text-sm font-bold text-white"
        >
          積
        </span>
        {/* 狭幅ではロゴマークのみ表示。md 以上で "TsumiWiki" テキストを追加(md=768pxはハンバーガーの閾値と一致) */}
        <span className="hidden text-base font-bold text-ink md:inline">TsumiWiki</span>
      </Link>

      <div className="mx-auto flex min-w-0 flex-1 justify-center">
        <SearchBox ref={searchInputRef} />
      </div>

      <div className="flex flex-shrink-0 items-center gap-1 md:gap-2">
        <button
          type="button"
          onClick={handleRescan}
          aria-label="更新確認"
          title="更新確認"
          className="flex h-8 items-center gap-1.5 rounded border border-line px-2 text-sm text-ink-soft hover:bg-hoverbg md:px-3 md:py-1.5"
        >
          <RefreshCw size={14} aria-hidden="true" />
          <span className="hidden md:inline">更新確認</span>
        </button>
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
