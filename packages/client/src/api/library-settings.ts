import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LibrarySettings } from '@tsumiwiki/shared';
import { ApiRequestError, api } from './client';
import { useToastStore } from '../stores/toast';

// #84 Phase 1: ライブラリ設定(テンプレ・デイリーノート)の R/W

export const LIBRARY_SETTINGS_QUERY_KEY = ['library-settings'] as const;

export interface LibrarySettingsData {
  settings: LibrarySettings;
  // #99: settings.yaml のパース/バリデーションに失敗しデフォルト値へフォールバックした状態か。
  //      true の場合、このまま保存すると git 上の正しい過去版を上書きしてしまう。
  corrupted: boolean;
}

export function useLibrarySettings() {
  return useQuery({
    queryKey: LIBRARY_SETTINGS_QUERY_KEY,
    queryFn: async () => {
      const { settings, corrupted } = await api<{ settings: LibrarySettings; corrupted: boolean }>(
        'GET',
        '/api/library/settings',
      );
      return { settings, corrupted } satisfies LibrarySettingsData;
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
      // 保存できた=有効な設定を書き込めたということなので、corrupted 状態は解消される
      queryClient.setQueryData(LIBRARY_SETTINGS_QUERY_KEY, {
        settings: res.settings,
        corrupted: false,
      } satisfies LibrarySettingsData);
      showToast('success', 'ライブラリ設定を保存しました');
    },
    onError: (err) => {
      showToast('error', err instanceof ApiRequestError ? err.message : '保存に失敗しました');
    },
  });
}
