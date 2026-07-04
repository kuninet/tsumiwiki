import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginRequest, User } from '@tsumiwiki/shared';
import { ApiRequestError, api } from './client';

export const ME_QUERY_KEY = ['me'] as const;

// 未ログイン(401)は「ユーザーなし」として扱う。それ以外のエラーは呼び出し側に伝播させる
export function useMe() {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: async (): Promise<User | null> => {
      try {
        const { user } = await api<{ user: User }>('GET', '/api/auth/me');
        return user;
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 401) {
          return null;
        }
        throw err;
      }
    },
    retry: false,
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
