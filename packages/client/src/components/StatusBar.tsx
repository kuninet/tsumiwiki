import { useParams } from 'react-router-dom';
import { useEditStore } from '../stores/edit';

// ステータスバー(components.md仕様)。高さ28px・bg-panel・border-t
// 左=状態(閲覧モード/編集中・ロック取得済み(あなた)/他者編集中/保存エラー)、
// 右=font-monoで文書パス。他者ロック名・保存エラーはDocViewがeditストアへ書き込む

export function StatusBar() {
  const mode = useEditStore((s) => s.mode);
  const lockedByOtherName = useEditStore((s) => s.lockedByOtherName);
  const saveError = useEditStore((s) => s.saveError);
  const params = useParams();
  const docPath = params['*'];

  if (!docPath) {
    return <footer className="h-[28px] flex-shrink-0 border-t border-line bg-panel" />;
  }

  const statusLabel = saveError
    ? '保存エラー'
    : lockedByOtherName
      ? `他者編集中(${lockedByOtherName}さん)`
      : mode === 'edit'
        ? '編集中 ・ ロック取得済み(あなた)'
        : '閲覧モード';

  return (
    <footer className="flex h-[28px] flex-shrink-0 items-center justify-between border-t border-line bg-panel px-4 text-xs text-ink-faint">
      <span data-testid="status-bar" className={saveError ? 'text-danger' : undefined}>
        {statusLabel}
      </span>
      <span className="font-mono">{docPath}</span>
    </footer>
  );
}
