import { useEffect, useRef } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useCreateOrOpenTodayNote } from '../api/daily-notes';
import { docUrl } from '../lib/doc-path';
import { confirmNavigationIfDirty } from '../lib/navigation-guard';
import { useUIStore } from '../stores/ui';
import { FolderTree } from './FolderTree';
import { Header } from './Header';
import { StatusBar } from './StatusBar';
import { TagPane } from './TagPane';
import { Toast } from './Toast';

// 認証済みレイアウト(SC-02の骨格・設計04章4.2・デザインhandoff components.md)

export function AppShell() {
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const sidebarTab = useUIStore((s) => s.sidebarTab);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const toggleSidebarCollapsed = useUIStore((s) => s.toggleSidebarCollapsed);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const requestCreateDoc = useUIStore((s) => s.requestCreateDoc);

  const navigate = useNavigate();
  const createOrOpenTodayNote = useCreateOrOpenTodayNote();

  function handleOpenTodayNote() {
    if (!confirmNavigationIfDirty()) return;
    createOrOpenTodayNote.mutate(undefined, {
      onSuccess: (res) => navigate(docUrl(res.path)),
    });
  }

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

  return (
    <div className="flex h-screen flex-col bg-canvas font-sans text-ink">
      <Header />

      <div className="flex min-h-0 flex-1">
        {!sidebarCollapsed && (
          <aside
            data-testid="sidebar"
            style={{ width: sidebarWidth }}
            className="relative flex flex-shrink-0 flex-col border-r border-line bg-panel"
          >
            <div className="flex flex-shrink-0 border-b border-line" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={sidebarTab === 'folder'}
                onClick={() => setSidebarTab('folder')}
                className={`flex-1 px-3 py-2 text-sm ${
                  sidebarTab === 'folder' ? 'bg-active font-semibold text-accent' : 'text-ink-faint'
                }`}
              >
                フォルダ
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sidebarTab === 'tag'}
                onClick={() => setSidebarTab('tag')}
                className={`flex-1 px-3 py-2 text-sm ${
                  sidebarTab === 'tag' ? 'bg-active font-semibold text-accent' : 'text-ink-faint'
                }`}
              >
                タグ
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {sidebarTab === 'folder' ? <FolderTree /> : <TagPane />}
            </div>
            <div className="flex h-[38px] flex-shrink-0 border-t border-line text-sm text-ink-soft">
              <button
                type="button"
                onClick={handleOpenTodayNote}
                disabled={createOrOpenTodayNote.isPending}
                aria-busy={createOrOpenTodayNote.isPending}
                className="flex flex-1 items-center justify-center gap-1 hover:bg-hoverbg disabled:cursor-progress disabled:opacity-50"
                title="今日の日誌を開く(なければ作成)"
              >
                <span aria-hidden="true">📓</span> 今日の日誌
              </button>
              <button
                type="button"
                onClick={requestCreateDoc}
                className="flex flex-1 items-center justify-center gap-1 border-l border-line hover:bg-hoverbg"
              >
                <span aria-hidden="true">+</span> 新規文書
              </button>
              <Link
                to="/trash"
                className="flex flex-1 items-center justify-center gap-1 border-l border-line hover:bg-hoverbg"
              >
                🗑 ごみ箱
              </Link>
            </div>
            <div
              onMouseDown={(e) => {
                e.preventDefault(); // ドラッグ中のテキスト選択を防ぐ
                draggingRef.current = true;
                document.body.style.userSelect = 'none';
                document.body.style.cursor = 'col-resize';
              }}
              className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent-soft"
            />
          </aside>
        )}
        <button
          type="button"
          onClick={toggleSidebarCollapsed}
          aria-label={sidebarCollapsed ? 'サイドバーを表示' : 'サイドバーを折りたたむ'}
          className="w-4 flex-shrink-0 border-r border-line text-ink-faint hover:bg-hoverbg"
        >
          {sidebarCollapsed ? '›' : '‹'}
        </button>
        <main className="min-w-0 flex-1 overflow-auto bg-canvas">
          <Outlet />
        </main>
      </div>

      <StatusBar />

      <Toast />
    </div>
  );
}
