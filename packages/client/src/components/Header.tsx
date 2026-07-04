import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { TAGS_QUERY_KEY, TREE_QUERY_KEY } from '../api/docs';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { SearchBox } from './SearchBox';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

// ヘッダー(components.md仕様)。高さ52px・bg-panel・border-b

export function Header() {
  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
    <header className="flex h-[52px] flex-shrink-0 items-center gap-4 border-b border-line bg-panel px-4">
      <Link to="/" className="flex flex-shrink-0 items-center gap-2">
        <span
          aria-hidden="true"
          style={{ background: 'var(--tw-accent-gradient)' }}
          className="flex h-[26px] w-[26px] items-center justify-center rounded text-sm font-bold text-white"
        >
          積
        </span>
        <span className="text-base font-bold text-ink">TsumiWiki</span>
      </Link>

      <SearchBox ref={searchInputRef} />

      <button
        type="button"
        onClick={handleRescan}
        className="flex flex-shrink-0 items-center gap-1.5 rounded border border-line px-3 py-1.5 text-sm text-ink-soft hover:bg-hoverbg"
      >
        <span aria-hidden="true">↻</span>
        更新確認
      </button>

      <div className="ml-auto flex flex-shrink-0 items-center gap-2">
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
