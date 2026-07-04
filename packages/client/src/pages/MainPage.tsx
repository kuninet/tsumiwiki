import { useParams } from 'react-router-dom';
import { useDoc } from '../api/docs';
import { ApiRequestError } from '../api/client';

// メイン画面(SC-02)の文書表示。WYSIWYG表示は#31でDocViewer/DocEditorに置換予定の暫定実装

function titleFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

export function MainPage() {
  const params = useParams();
  const docPath = params['*'];
  const { data: doc, isLoading, error } = useDoc(docPath);

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

  if (!doc) return null;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-gray-800">{titleFromPath(doc.path)}</h1>
      <p className="mt-1 text-sm text-gray-500">更新日時: {doc.updatedAt}</p>
      {/* WYSIWYG表示は#31で置換予定の暫定表示 */}
      <pre className="mt-4 whitespace-pre-wrap text-sm text-gray-800">{doc.body}</pre>
    </div>
  );
}
