import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApplyTemplateRequest,
  ApplyTemplateResponse,
  ListTemplatesResponse,
} from '@tsumiwiki/shared';
import { useToastStore } from '../stores/toast';
import { ApiRequestError, api } from './client';
import { TAGS_QUERY_KEY, TREE_QUERY_KEY } from './docs';

// #84 Phase B: テンプレート API 用のフック群。
// - useTemplates: `settings.templates.folder` 配下のテンプレ一覧を取得(選択モーダル用)
// - useApplyTemplate: 選んだテンプレを変数展開して新規文書を作成する

export const TEMPLATES_QUERY_KEY = ['templates'] as const;

// テンプレ一覧はモーダルが mount された時だけ呼ばれる(呼び出し側で条件付き render するのが前提)。
// 頻繁には変わらない想定なので staleTime を長めに置いてモーダル再オープン時の再フェッチを避ける。
export function useTemplates() {
  return useQuery({
    queryKey: TEMPLATES_QUERY_KEY,
    queryFn: () => api<ListTemplatesResponse>('GET', '/api/templates'),
    staleTime: 30_000,
  });
}

export function useApplyTemplate() {
  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);
  return useMutation({
    mutationFn: (body: ApplyTemplateRequest) =>
      api<ApplyTemplateResponse>('POST', '/api/templates/apply', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY });
      showToast('success', 'テンプレートから文書を作成しました');
    },
    onError: (err) => {
      showToast(
        'error',
        err instanceof ApiRequestError ? err.message : 'テンプレートを適用できませんでした',
      );
    },
  });
}
