import { useEditStore } from '../stores/edit';

// 未保存編集中のアプリ内遷移ガード(#31レビュー由来のパターンを共通化)
export const UNSAVED_NAVIGATION_WARNING = '未保存の変更があります。移動しますか?';

export function confirmNavigationIfDirty(): boolean {
  if (!useEditStore.getState().dirty) return true;
  return window.confirm(UNSAVED_NAVIGATION_WARNING);
}
