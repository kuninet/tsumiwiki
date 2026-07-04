import { useEffect } from 'react';
import { Navigate, Outlet, useNavigate } from 'react-router-dom';
import { useMe } from '../api/auth';

// 未認証時の/loginリダイレクトを一箇所に集約する(設計04章4.1)

export function RequireAuth() {
  const { data: user, isLoading } = useMe();
  const navigate = useNavigate();

  useEffect(() => {
    const handleUnauthorized = () => navigate('/login', { replace: true });
    window.addEventListener('tsumiwiki:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('tsumiwiki:unauthorized', handleUnauthorized);
  }, [navigate]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center" role="status">
        読み込み中...
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
