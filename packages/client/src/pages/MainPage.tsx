import { useNavigate, useParams } from 'react-router-dom';
import { useMe } from '../api/auth';
import { ApiRequestError } from '../api/client';
import { useDoc } from '../api/docs';
import { useRecentDocs } from '../api/search';
import { DocView } from '../components/DocView';
import { docUrl } from '../lib/doc-path';
import { useEditStore } from '../stores/edit';

// メイン画面(SC-02)。文書未選択時は最近更新一覧、選択時はDocViewで閲覧・編集する

function RecentDocsList() {
  const { data: docs, isLoading } = useRecentDocs();
  const navigate = useNavigate();

  return (
    <div className="p-6">
      <h1 className="text-lg font-bold text-gray-800">最近更新した文書</h1>

      {isLoading && <p className="mt-4 text-sm text-gray-500">読み込み中...</p>}

      {!isLoading && (docs ?? []).length === 0 && (
        <p className="mt-4 text-sm text-gray-500">文書がありません</p>
      )}

      {!isLoading && (docs ?? []).length > 0 && (
        <ul className="mt-4 divide-y divide-gray-100">
          {(docs ?? []).map((doc) => (
            <li key={doc.path}>
              <button
                type="button"
                onClick={() => navigate(docUrl(doc.path))}
                className="block w-full py-2 text-left hover:bg-gray-50"
              >
                <div className="text-sm font-medium text-gray-800">{doc.title}</div>
                <div className="text-xs text-gray-500">
                  {doc.folder || '(ルート)'} ・ {doc.updatedAt}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
    return <RecentDocsList />;
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
