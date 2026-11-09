import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useTree } from '../api/docs';
import { useUIStore } from '../stores/ui';

// #323: 開いている文書(URL の /doc/* ・ /history/* のパス)にフォルダツリーを追従させる。
// - URL のパスが「直近に追従したパス」と変わったときだけ revealInTree を呼ぶ。
//   毎回呼ぶと、利用者が手で閉じたフォルダが tree の再取得や再描画で開き直してしまう
// - tree 取得前や、tree にまだ無いパス(作成直後・.md なし URL・存在しない文書)は追従せず待つ。
//   tree が更新されて文書が現れた時点で追従する
// - enabled は #324 の個人設定(followActiveDocInTree)から渡す想定。本 issue では常に true
export interface FollowActiveDocInTreeOptions {
  enabled?: boolean;
}

export function useFollowActiveDocInTree(options: FollowActiveDocInTreeOptions = {}): void {
  const enabled = options.enabled ?? true;
  const params = useParams();
  const currentPath = params['*'] ?? '';
  const { data: tree } = useTree();
  const lastFollowedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!currentPath) {
      // 文書を開いていない画面(/ ・ /settings など)に来たら記録を消す。
      // 次に同じ文書を開いたときも「開き直した」として追従する
      lastFollowedRef.current = null;
      return;
    }
    if (!enabled) return;
    if (currentPath === lastFollowedRef.current) return;
    if (!tree) return;
    if (!tree.docs.some((d) => d.path === currentPath)) return;
    lastFollowedRef.current = currentPath;
    useUIStore.getState().revealInTree(currentPath);
  }, [enabled, currentPath, tree]);
}
