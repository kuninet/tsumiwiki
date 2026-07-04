import { useParams } from 'react-router-dom';
import { useEditStore } from '../stores/edit';

// ステータスバー(components.md仕様)。高さ28px・bg-panel・border-t
// 左=状態(閲覧モード/編集中・ロック取得済み(あなた))、右=font-monoで文書パス
//
// 「他者編集中」「保存エラー」状態はDocView側のdoc.lock情報が必要なため、
// editor/配下・DocViewを変更しない今回のスコープでは未実装(第2弾で対応)

export function StatusBar() {
  const mode = useEditStore((s) => s.mode);
  const params = useParams();
  const docPath = params['*'];

  if (!docPath) {
    return <footer className="h-[28px] flex-shrink-0 border-t border-line bg-panel" />;
  }

  const statusLabel = mode === 'edit' ? '編集中 ・ ロック取得済み(あなた)' : '閲覧モード';

  return (
    <footer className="flex h-[28px] flex-shrink-0 items-center justify-between border-t border-line bg-panel px-4 text-xs text-ink-faint">
      <span data-testid="status-bar">{statusLabel}</span>
      <span className="font-mono">{docPath}</span>
    </footer>
  );
}
