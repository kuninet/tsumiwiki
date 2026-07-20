import { useCallback, useState } from 'react';
import { useMe } from '../api/auth';
import { ApiRequestError } from '../api/client';
import { useDoc } from '../api/docs';
import { useTabsStore } from '../stores/tabs';
import { DocView } from './DocView';

// 1タブ分の文書ペイン(Epic #133 / Phase A-1)。
// - タブ切替で unmount されないよう MainPage 側で常に全タブ分マウントしておく
// - active=false のタブは MainPage 側で display:none にされている(状態は生きたまま保持)
// - active=false のタブは useEditStore(グローバル)へ書き込まない(useEditingSession/DocView 内でゲート)

interface DocTabProps {
  path: string;
  active: boolean;
}

export function DocTab({ path, active }: DocTabProps) {
  const markDirty = useTabsStore((s) => s.markDirty);
  // このタブの編集モードを自前で持つ(グローバル useEditStore.mode はアクティブタブ
  // のモードなので、他タブがアクティブになった瞬間に背景 edit タブの refetch が
  // 再開してしまう M1 対策)。DocView から onModeChange で通知させる。
  const [tabMode, setTabMode] = useState<'view' | 'edit'>('view');
  // 閲覧中は 60 秒間隔で refetch、編集中は上書き回避のため停止(既存挙動と同じ)。
  // 非アクティブでも閲覧なら refetch を続け、他者更新に追随させる
  const { data: doc, isLoading, error } = useDoc(path, {
    refetchInterval: tabMode === 'view' ? 60_000 : false,
  });
  const { data: currentUser } = useMe();

  // markDirty は zustand の action で参照安定だが、path とセットにした callback を
  // 再生成しないよう useCallback で包み、DocView 側の useEffect が毎レンダー発火しないようにする(M3)
  const handleDirtyChange = useCallback(
    (dirty: boolean) => markDirty(path, dirty),
    [path, markDirty],
  );

  if (isLoading) {
    return (
      <div className="p-6 text-ink-faint" role="status">
        読み込み中...
      </div>
    );
  }

  if (error) {
    const message =
      error instanceof ApiRequestError && error.status === 404
        ? '指定された文書が見つかりません'
        : '文書の取得に失敗しました';
    return <div className="p-6 text-danger">{message}</div>;
  }

  if (!doc || !currentUser) return null;

  return (
    <DocView
      doc={doc}
      currentUser={currentUser}
      active={active}
      onDirtyChange={handleDirtyChange}
      onModeChange={setTabMode}
    />
  );
}
