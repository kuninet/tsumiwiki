import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Navigate, Outlet, useNavigate } from 'react-router-dom';
import { ME_QUERY_KEY, useMe } from '../api/auth';

// 未認証時の/loginリダイレクトを一箇所に集約する(設計04章4.1)
// - 初回ロード中・キャッシュ未確定の再取得中は保護コンテンツを描画しない
//   (古いキャッシュでの一瞬の描画=ちらつきと不要API発火の防止)
// - meの取得失敗(ネットワーク断等)は誤ログアウトにせず再試行UIを出す

export function RequireAuth() {
  const { data: user, isLoading, isFetching, isError, refetch } = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    const handleUnauthorized = () => {
      // 古いユーザーのキャッシュを残さない(戻る操作でのちらつき防止)
      queryClient.setQueryData(ME_QUERY_KEY, null);
      navigate('/login', { replace: true });
    };
    window.addEventListener('tsumiwiki:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('tsumiwiki:unauthorized', handleUnauthorized);
  }, [navigate, queryClient]);

  if (isLoading || (isFetching && user === undefined)) {
    return (
      <div className="flex h-screen items-center justify-center" role="status">
        読み込み中...
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <p>サーバーに接続できません</p>
        <button
          type="button"
          className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          onClick={() => void refetch()}
        >
          再試行
        </button>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
