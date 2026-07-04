import type { TrashEntry } from '@tsumiwiki/shared';
import { useState } from 'react';
import { useMe } from '../api/auth';
import { usePurgeTrash, useRestoreTrash, useTrash } from '../api/trash';
import { ConfirmDialog } from '../components/ConfirmDialog';

// ごみ箱ページ(SC-07・設計04章4.3)

function formatDateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('ja-JP') : '不明';
}

export function TrashPage() {
  const { data: entries, isLoading } = useTrash();
  const { data: currentUser } = useMe();
  const restoreTrash = useRestoreTrash();
  const purgeTrash = usePurgeTrash();
  const [purgeTarget, setPurgeTarget] = useState<TrashEntry | null>(null);

  const isAdmin = currentUser?.role === 'admin';

  function handleConfirmPurge() {
    if (!purgeTarget) return;
    purgeTrash.mutate(purgeTarget.trashPath);
    setPurgeTarget(null);
  }

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-gray-800">ごみ箱</h1>

      {isLoading && <p className="mt-4 text-sm text-gray-500">読み込み中...</p>}

      {!isLoading && (entries ?? []).length === 0 && (
        <p className="mt-4 text-sm text-gray-500">ごみ箱は空です</p>
      )}

      {!isLoading && (entries ?? []).length > 0 && (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-gray-500">
              <th className="py-2 font-medium">名前</th>
              <th className="py-2 font-medium">元のパス</th>
              <th className="py-2 font-medium">削除日時</th>
              <th className="py-2 font-medium">削除者</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {(entries ?? []).map((entry) => (
              <tr key={entry.trashPath} className="border-b border-gray-100">
                <td className="py-2 text-gray-800">
                  {entry.isFolder ? '📁 ' : ''}
                  {entry.name}
                </td>
                <td className="py-2 text-gray-500">{entry.originalPath ?? '不明'}</td>
                <td className="py-2 text-gray-500">{formatDateTime(entry.deletedAt)}</td>
                <td className="py-2 text-gray-500">{entry.deletedBy ?? '不明'}</td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    onClick={() => restoreTrash.mutate(entry.trashPath)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100"
                  >
                    復元
                  </button>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => setPurgeTarget(entry)}
                      className="ml-2 rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    >
                      完全削除
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {purgeTarget && (
        <ConfirmDialog
          title="完全削除"
          message={`「${purgeTarget.name}」を完全に削除します。元に戻せません。よろしいですか?`}
          onConfirm={handleConfirmPurge}
          onCancel={() => setPurgeTarget(null)}
        />
      )}
    </div>
  );
}
