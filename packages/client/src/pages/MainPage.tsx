import { useParams } from 'react-router-dom';
import { useMe } from '../api/auth';
import { ApiRequestError } from '../api/client';
import { useDoc } from '../api/docs';
import { DocView } from '../components/DocView';
import { useEditStore } from '../stores/edit';

// メイン画面(SC-02)。文書未選択時はプレースホルダ、選択時はDocViewで閲覧・編集する

export function MainPage() {
  const params = useParams();
  const docPath = params['*'];
  const editMode = useEditStore((s) => s.mode);
  const { data: doc, isLoading, error } = useDoc(docPath, {
    // 編集中は他者更新の取り込みでロック取得直後の内容が上書きされないよう再取得を止める
    refetchInterval: editMode === 'view' ? 60_000 : false,
  });
  const { data: currentUser } = useMe();

  if (!docPath) {
    return (
      <div className="p-6 text-gray-500">
        <p>文書を選択してください</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-6 text-gray-500" role="status">
        読み込み中...
      </div>
    );
  }

  if (error) {
    const message =
      error instanceof ApiRequestError && error.status === 404
        ? '指定された文書が見つかりません'
        : '文書の取得に失敗しました';
    return <div className="p-6 text-red-600">{message}</div>;
  }

  if (!doc || !currentUser) return null;

  return <DocView key={doc.path} doc={doc} currentUser={currentUser} />;
}
