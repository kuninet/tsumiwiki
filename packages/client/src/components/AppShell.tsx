import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useLogout, useMe } from '../api/auth';
import { api } from '../api/client';
import { TAGS_QUERY_KEY, TREE_QUERY_KEY } from '../api/docs';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { useUIStore } from '../stores/ui';
import { FolderTree } from './FolderTree';
import { SearchBox } from './SearchBox';
import { TagPane } from './TagPane';
import { Toast } from './Toast';

// 認証済みレイアウト(SC-02の骨格・設計04章4.2)

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function AppShell() {
  const { data: user } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const sidebarTab = useUIStore((s) => s.sidebarTab);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const toggleSidebarCollapsed = useUIStore((s) => s.toggleSidebarCollapsed);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const editDirty = useEditStore((s) => s.dirty);
  const lockedPath = useEditStore((s) => s.lockedPath);
  const lastDraftSavedAt = useEditStore((s) => s.lastDraftSavedAt);

  const draggingRef = useRef(false);

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!draggingRef.current) return;
      setSidebarWidth(e.clientX);
    }
    function handleMouseUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [setSidebarWidth]);

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

  function handleLogout() {
    logout.mutate(undefined, {
      onSuccess: () => navigate('/login', { replace: true }),
    });
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-gray-200 px-4 py-2">
        <Link to="/" className="text-lg font-bold text-gray-800">
          TsumiWiki
        </Link>
        <SearchBox />
        <button
          type="button"
          onClick={handleRescan}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
        >
          更新確認
        </button>
        <div className="ml-auto flex items-center gap-3">
          {user && <span className="text-sm text-gray-700">{user.displayName}</span>}
          <button
            type="button"
            onClick={handleLogout}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            ログアウト
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {!sidebarCollapsed && (
          <aside
            data-testid="sidebar"
            style={{ width: sidebarWidth }}
            className="relative flex flex-shrink-0 flex-col border-r border-gray-200"
          >
            <div className="flex flex-shrink-0 border-b border-gray-200">
              <button
                type="button"
                onClick={() => setSidebarTab('folder')}
                className={`flex-1 px-3 py-2 text-sm ${
                  sidebarTab === 'folder'
                    ? 'border-b-2 border-blue-600 font-medium text-blue-600'
                    : 'text-gray-500'
                }`}
              >
                フォルダ
              </button>
              <button
                type="button"
                onClick={() => setSidebarTab('tag')}
                className={`flex-1 px-3 py-2 text-sm ${
                  sidebarTab === 'tag'
                    ? 'border-b-2 border-blue-600 font-medium text-blue-600'
                    : 'text-gray-500'
                }`}
              >
                タグ
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {sidebarTab === 'folder' ? <FolderTree /> : <TagPane />}
            </div>
            <Link
              to="/trash"
              className="flex-shrink-0 border-t border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100"
            >
              🗑 ごみ箱
            </Link>
            <div
              onMouseDown={(e) => {
                e.preventDefault(); // ドラッグ中のテキスト選択を防ぐ
                draggingRef.current = true;
                document.body.style.userSelect = 'none';
                document.body.style.cursor = 'col-resize';
              }}
              className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-300"
            />
          </aside>
        )}
        <button
          type="button"
          onClick={toggleSidebarCollapsed}
          aria-label={sidebarCollapsed ? 'サイドバーを表示' : 'サイドバーを折りたたむ'}
          className="w-4 flex-shrink-0 border-r border-gray-200 text-gray-400 hover:bg-gray-100"
        >
          {sidebarCollapsed ? '›' : '‹'}
        </button>
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>

      <footer className="flex h-6 flex-shrink-0 items-center border-t border-gray-200 px-4 text-xs text-gray-400">
        {lockedPath && (
          <span data-testid="status-bar">
            編集中: {lockedPath}
            {' ・ '}
            {lastDraftSavedAt
              ? `自動保存 ${formatTime(lastDraftSavedAt)}`
              : editDirty
                ? '未保存の変更があります'
                : '保存済み'}
          </span>
        )}
      </footer>

      <Toast />
    </div>
  );
}
