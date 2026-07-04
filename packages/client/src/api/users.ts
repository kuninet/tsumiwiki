import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateUserRequest, UpdateUserRequest, User } from '@tsumiwiki/shared';
import { ApiRequestError, api } from './client';
import { useToastStore } from '../stores/toast';

// ユーザー管理API(FR-AUTH-02。admin専用)

export const USERS_QUERY_KEY = ['users'] as const;

export function useUsers() {
  return useQuery({
    queryKey: USERS_QUERY_KEY,
    queryFn: async () => {
      const { users } = await api<{ users: User[] }>('GET', '/api/users');
      return users;
    },
  });
}

function useUsersMutation<TVariables>(
  mutationFn: (variables: TVariables) => Promise<unknown>,
  successMessage: string,
) {
  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);
  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
      showToast('success', successMessage);
    },
    onError: (err) => {
      showToast('error', err instanceof ApiRequestError ? err.message : '操作に失敗しました');
    },
  });
}

export function useCreateUser() {
  return useUsersMutation(
    (body: CreateUserRequest) => api<{ user: User }>('POST', '/api/users', body),
    'ユーザーを追加しました',
  );
}

export function useUpdateUser() {
  return useUsersMutation(
    ({ id, body }: { id: number; body: UpdateUserRequest }) =>
      api<{ user: User }>('PATCH', `/api/users/${id}`, body),
    '更新しました',
  );
}

// 個人設定画面から呼ぶ素の関数(成功/失敗のトースト表示はフォーム側で行うため)
export function changeMyPassword(body: {
  currentPassword: string;
  newPassword: string;
}): Promise<{ ok: boolean }> {
  return api('PUT', '/api/me/password', body);
}
