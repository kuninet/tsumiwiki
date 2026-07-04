import { type FormEvent, useState } from 'react';
import { useMe } from '../api/auth';
import { ApiRequestError } from '../api/client';
import { changeMyPassword } from '../api/users';
import { useToastStore } from '../stores/toast';

// 個人設定画面(SC-06)。アカウント情報表示とパスワード変更

export function SettingsPage() {
  const { data: currentUser } = useMe();
  const showToast = useToastStore((s) => s.show);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('新しいパスワードが一致しません');
      return;
    }

    setSubmitting(true);
    try {
      await changeMyPassword({ currentPassword, newPassword });
      showToast('success', 'パスワードを変更しました');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'パスワードの変更に失敗しました');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-gray-800">個人設定</h1>

      {currentUser && (
        <div className="mt-4 max-w-sm rounded border border-gray-200 p-4 text-sm">
          <dl className="space-y-1">
            <div className="flex gap-2">
              <dt className="w-20 flex-shrink-0 text-gray-500">ユーザーID</dt>
              <dd className="text-gray-800">{currentUser.username}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 flex-shrink-0 text-gray-500">表示名</dt>
              <dd className="text-gray-800">{currentUser.displayName}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 flex-shrink-0 text-gray-500">ロール</dt>
              <dd className="text-gray-800">{currentUser.role === 'admin' ? '管理者' : '一般'}</dd>
            </div>
          </dl>
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 max-w-sm space-y-3">
        <h2 className="text-sm font-bold text-gray-700">パスワード変更</h2>

        <label className="block text-sm text-gray-700">
          現在のパスワード
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm text-gray-700">
          新しいパスワード
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm text-gray-700">
          新しいパスワード(確認)
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>

        {error && (
          <p data-testid="password-error" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-60"
        >
          変更する
        </button>
      </form>
    </div>
  );
}
