import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TREE_QUERY_KEY } from './docs';
import { ALL_HISTORY_QUERY_KEY } from './history';
import { ApiRequestError, api } from './client';
import { useToastStore } from '../stores/toast';

// #84 Phase 2: 『今日の日誌』ボタン用 API。POST は「取得または作成」の両方を担う。
// レスポンスの created で新規作成/既存を区別してトースト分けする。

export function useCreateOrOpenTodayNote() {
  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);
  return useMutation({
    mutationFn: () =>
      api<{ path: string; created: boolean }>('POST', '/api/daily-notes/today', {}),
    onSuccess: (res) => {
      if (res.created) {
        queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: ALL_HISTORY_QUERY_KEY });
        showToast('success', '今日の日誌を作成しました');
      } else {
        // 既存の場合も無反応にならないよう軽く通知(既に該当ページに居るとき用)
        showToast('info', '今日の日誌を開きました');
      }
    },
    onError: (err) => {
      showToast('error', err instanceof ApiRequestError ? err.message : '日誌を開けませんでした');
    },
  });
}
