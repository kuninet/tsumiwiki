// DocHeaderの保存バッジ(デザインhandoff components.md)。
// 保存済み(success) / 未保存の変更(warning) / 自動保存済み(ink-faint)

export interface SaveBadge {
  label: string;
  className: string;
}

export function saveBadge(dirty: boolean, lastDraftSavedAt: string | null): SaveBadge {
  if (!dirty) return { label: '保存済み', className: 'text-success' };
  if (lastDraftSavedAt) return { label: '自動保存済み', className: 'text-ink-faint' };
  return { label: '未保存の変更', className: 'text-warning' };
}
