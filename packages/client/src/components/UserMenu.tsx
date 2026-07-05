import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLogout, useMe } from '../api/auth';

// アバター+ユーザーメニュー(components.md Header仕様)。30×30円のアバターをクリックで
// 設定・ログアウトへのドロップダウンを開く

export function UserMenu() {
  const { data: user } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener('mousedown', handleOutsideClick);
    return () => window.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  function handleLogout() {
    logout.mutate(undefined, {
      onSuccess: () => navigate('/login', { replace: true }),
    });
  }

  if (!user) return null;

  const initial = user.displayName.charAt(0);

  return (
    <div ref={containerRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`ユーザーメニュー(${user.displayName})`}
        title={user.displayName}
        className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-accent text-sm font-semibold text-white"
      >
        {initial}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-[40] mt-1 w-40 rounded-lg border border-line bg-panel py-1 shadow-lg"
        >
          <div className="truncate border-b border-line px-3 py-2 text-xs text-ink-faint">
            {user.displayName}
          </div>
          {user.role === 'admin' && (
            <>
              <Link
                to="/admin/users"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="block px-3 py-2 text-sm text-ink-soft hover:bg-hoverbg"
              >
                ユーザー管理
              </Link>
              <Link
                to="/admin/library"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="block px-3 py-2 text-sm text-ink-soft hover:bg-hoverbg"
              >
                ライブラリ設定
              </Link>
            </>
          )}
          <Link
            to="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm text-ink-soft hover:bg-hoverbg"
          >
            設定
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={handleLogout}
            className="block w-full px-3 py-2 text-left text-sm text-ink-soft hover:bg-hoverbg"
          >
            ログアウト
          </button>
        </div>
      )}
    </div>
  );
}
