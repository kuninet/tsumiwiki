import { useEffect, useRef } from 'react';
import { useTree } from '../api/docs';
import { getAllOpenPathsFromState, useTabsStore } from '../stores/tabs';
import { useToastStore } from '../stores/toast';

// Phase D(#139): 起動時にタブ復元の後始末をする。
// - 永続化されていたタブが指す文書が削除/リネームされていれば closeTab で除去
// - まとめてトーストで「N 件のタブが復元できませんでした」と通知
//
// 実装メモ:
// - useTree の初回成功後に 1 回だけ走らせる(refetch のたびに閉じないように ref で追跡)
// - tree の docs 一覧に含まれない path のタブが「復元不能」

export function useTabsBootCleanup() {
  const { data: tree, isSuccess } = useTree();
  const ranRef = useRef(false);
  const showToast = useToastStore((s) => s.show);

  useEffect(() => {
    if (!isSuccess || !tree || ranRef.current) return;
    ranRef.current = true;
    const openPaths = getAllOpenPathsFromState(useTabsStore.getState());
    if (openPaths.length === 0) return;
    const validSet = new Set(tree.docs.map((d) => d.path));
    const missing = openPaths.filter((p) => !validSet.has(p));
    if (missing.length === 0) return;
    for (const p of missing) useTabsStore.getState().closeTab(p);
    showToast(
      'info',
      missing.length === 1
        ? `復元できないタブを 1 件閉じました: ${missing[0]}`
        : `復元できないタブを ${missing.length} 件閉じました`,
    );
  }, [isSuccess, tree, showToast]);
}
