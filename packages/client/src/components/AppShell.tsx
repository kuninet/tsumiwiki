import { useEffect, useRef } from 'react';
import { Link, Outlet } from 'react-router-dom';
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
    <div className="flex h-screen min-w-[1280px] flex-col bg-canvas font-sans text-ink">
      <Header />

      <div className="flex min-h-0 flex-1">
        {!sidebarCollapsed && (
          <aside
            data-testid="sidebar"
            style={{ width: sidebarWidth }}
            className="relative flex flex-shrink-0 flex-col border-r border-line bg-panel"
          >
            <div className="flex flex-shrink-0 border-b border-line">
              <button
                type="button"
                onClick={() => setSidebarTab('folder')}
                className={`flex-1 px-3 py-2 text-sm ${
                  sidebarTab === 'folder' ? 'bg-active font-semibold text-accent' : 'text-ink-faint'
                }`}
              >
                フォルダ
              </button>
              <button
                type="button"
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
            <Link
              to="/trash"
              className="flex h-[38px] flex-shrink-0 items-center border-t border-line px-3 text-sm text-ink-soft hover:bg-hoverbg"
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
