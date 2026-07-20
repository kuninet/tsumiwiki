import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useCreateOrOpenTodayNote } from '../api/daily-notes';
import { useApplyTemplate } from '../api/templates';
import { useMediaQuery } from '../hooks/use-media-query';
import { docUrl } from '../lib/doc-path';
import { useUIStore } from '../stores/ui';
import { FolderTree } from './FolderTree';
import { Header } from './Header';
import { StatusBar } from './StatusBar';
import { TagPane } from './TagPane';
import { TemplatePickerDialog } from './TemplatePickerDialog';
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
  const applyTemplate = useApplyTemplate();
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  function handleOpenTodayNote() {
    // タブ化(#133)以降、新規文書を開いても現在の dirty タブは残るので確認不要
    createOrOpenTodayNote.mutate(undefined, {
      onSuccess: (res) => navigate(docUrl(res.path)),
    });
  }

  function handleOpenTemplatePicker() {
    // タブ化(#133)以降、新規文書を開いても現在の dirty タブは残るので確認不要
    setTemplatePickerOpen(true);
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

  // モバイル判定(Tailwind md=768px に合わせる)。狭幅端末ではサイドバーをドロワー化する
  const isMobile = useMediaQuery('(max-width: 767px)');
  // 初回モバイル判定 or デスクトップ→モバイル遷移で自動折畳。
  // prev の初期値を false にすることで、iPhone等での初回接続時にも「false→true」エッジが発火する
  const prevIsMobileRef = useRef(false);
  useEffect(() => {
    if (isMobile && !prevIsMobileRef.current) {
      useUIStore.setState({ sidebarCollapsed: true });
    }
    prevIsMobileRef.current = isMobile;
  }, [isMobile]);

  // モバイル時にルート変化(文書選択など)があればドロワーを閉じる。
  // ドロワー内でフォルダ/タグを開くだけならURLは変わらないので閉じない
  const location = useLocation();
  useEffect(() => {
    if (isMobile) {
      useUIStore.setState({ sidebarCollapsed: true });
    }
  }, [isMobile, location.pathname]);

  return (
    <div className="flex h-screen flex-col bg-canvas font-sans text-ink">
      <Header />

      <div className="relative flex min-h-0 flex-1">
        {/* モバイル時のみ、開いているときに背景オーバーレイを表示。クリックで閉じる */}
        {isMobile && !sidebarCollapsed && (
          <div
            data-testid="sidebar-overlay"
            className="fixed inset-0 z-30 bg-black/40"
            onClick={toggleSidebarCollapsed}
          />
        )}
        {(!isMobile ? !sidebarCollapsed : true) && (
          <aside
            data-testid="sidebar"
            style={isMobile ? undefined : { width: sidebarWidth }}
            className={
              isMobile
                ? `fixed inset-y-0 left-0 z-40 flex w-[300px] max-w-[85vw] flex-col border-r border-line bg-panel shadow-xl transition-transform duration-200 ${
                    sidebarCollapsed ? '-translate-x-full' : 'translate-x-0'
                  }`
                : 'relative flex flex-shrink-0 flex-col border-r border-line bg-panel'
            }
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
                onClick={handleOpenTemplatePicker}
                disabled={applyTemplate.isPending}
                aria-busy={applyTemplate.isPending}
                className="flex flex-1 items-center justify-center gap-1 border-l border-line hover:bg-hoverbg disabled:cursor-progress disabled:opacity-50"
                title="テンプレートから新規作成"
              >
                <span aria-hidden="true">📄</span> テンプレから新規
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
            {!isMobile && (
              <div
                data-testid="sidebar-resize-handle"
                onMouseDown={(e) => {
                  e.preventDefault(); // ドラッグ中のテキスト選択を防ぐ
                  draggingRef.current = true;
                  document.body.style.userSelect = 'none';
                  document.body.style.cursor = 'col-resize';
                }}
                className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent-soft"
              />
            )}
          </aside>
        )}
        {!isMobile && (
          <button
            type="button"
            onClick={toggleSidebarCollapsed}
            aria-label={sidebarCollapsed ? 'サイドバーを表示' : 'サイドバーを折りたたむ'}
            className="w-4 flex-shrink-0 border-r border-line text-ink-faint hover:bg-hoverbg"
          >
            {sidebarCollapsed ? '›' : '‹'}
          </button>
        )}
        <main className="min-w-0 flex-1 overflow-auto bg-canvas">
          <Outlet />
        </main>
      </div>

      <StatusBar />

      {templatePickerOpen && (
        <TemplatePickerDialog
          mode="create"
          onCancel={() => setTemplatePickerOpen(false)}
          onSubmit={(result) => {
            // AppShell からは 'create' でしか開かないので narrow
            if (result.mode !== 'create') return;
            setTemplatePickerOpen(false);
            applyTemplate.mutate(
              {
                templatePath: result.templatePath,
                title: result.title,
                targetFolder: result.targetFolder || undefined,
              },
              {
                onSuccess: (res) => navigate(docUrl(res.path)),
              },
            );
          }}
        />
      )}

      <Toast />
    </div>
  );
}
