import { Navigate, Outlet } from 'react-router-dom';
import { useMe } from '../api/auth';

// 管理者専用ルートのガード(設計04章4.1)。RequireAuth配下でのみ使う前提

export function RequireAdmin() {
  const { data: user } = useMe();

  if (user?.role !== 'admin') {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
