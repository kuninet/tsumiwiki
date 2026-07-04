import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginRequest, User } from '@tsumiwiki/shared';
import { api } from './client';

export const ME_QUERY_KEY = ['me'] as const;

// 未ログイン(401)は「ユーザーなし」として扱う。それ以外のエラーは呼び出し側に伝播させる
export function useMe() {
  return useQuery<User | null>({
    queryKey: ME_QUERY_KEY,
    // meは未認証でも200で{user:null}を返す公開プローブ(サーバー側で対応済み)。
    // 一時的なネットワークエラーで誤ログアウトしないよう1回リトライする
    queryFn: async () => {
      const res = await api<{ user: User | null }>('GET', '/api/auth/me');
      return res.user;
    },
    retry: 1,
    staleTime: 30_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => api<{ user: User }>('POST', '/api/auth/login', body),
    onSuccess: ({ user }) => {
      queryClient.setQueryData(ME_QUERY_KEY, user);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean }>('POST', '/api/auth/logout'),
    onSuccess: () => {
      queryClient.setQueryData(ME_QUERY_KEY, null);
    },
  });
}
