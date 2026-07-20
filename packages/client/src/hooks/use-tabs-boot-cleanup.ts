import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
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
  // Opus D レビュー M1 対応: bookmark 等で /doc/foo に直アクセスして foo が
  // 既に削除済みだった場合、useTabsUrlSync が openDoc(foo) で preview タブを
  // 作った直後にこの cleanup が「復元できません」トーストで閉じてしまう。
  // 現在の URL は「今アクセスしようとしている path」なので cleanup 対象から除外する
  const urlPath = useParams()['*'];

  useEffect(() => {
    if (!isSuccess || !tree || ranRef.current) return;
    ranRef.current = true;
    const openPaths = getAllOpenPathsFromState(useTabsStore.getState());
    if (openPaths.length === 0) return;
    const validSet = new Set(tree.docs.map((d) => d.path));
    const missing = openPaths.filter((p) => !validSet.has(p) && p !== urlPath);
    if (missing.length === 0) return;
    for (const p of missing) useTabsStore.getState().closeTab(p);
    // 個別 path はトーストで折り返しが崩れるので件数のみ通知(Opus M2)。
    // 詳細が要るなら DevTools console などで確認する運用
    showToast(
      'info',
      missing.length === 1
        ? '復元できないタブを 1 件閉じました'
        : `復元できないタブを ${missing.length} 件閉じました`,
    );
  }, [isSuccess, tree, showToast, urlPath]);
}
