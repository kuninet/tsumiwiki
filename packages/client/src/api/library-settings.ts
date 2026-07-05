import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LibrarySettings } from '@tsumiwiki/shared';
import { ApiRequestError, api } from './client';
import { useToastStore } from '../stores/toast';

// #84 Phase 1: ライブラリ設定(テンプレ・デイリーノート)の R/W

export const LIBRARY_SETTINGS_QUERY_KEY = ['library-settings'] as const;

export function useLibrarySettings() {
  return useQuery({
    queryKey: LIBRARY_SETTINGS_QUERY_KEY,
    queryFn: async () => {
      const { settings } = await api<{ settings: LibrarySettings }>('GET', '/api/library/settings');
      return settings;
    },
  });
}

export function useUpdateLibrarySettings() {
  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);
  return useMutation({
    mutationFn: (body: LibrarySettings) =>
      api<{ settings: LibrarySettings }>('PUT', '/api/library/settings', body),
    onSuccess: (res) => {
      queryClient.setQueryData(LIBRARY_SETTINGS_QUERY_KEY, res.settings);
      showToast('success', 'ライブラリ設定を保存しました');
    },
    onError: (err) => {
      showToast('error', err instanceof ApiRequestError ? err.message : '保存に失敗しました');
    },
  });
}
