import { type FormEvent, useState } from 'react';
import { useMe } from '../api/auth';
import { ApiRequestError } from '../api/client';
import { changeMyPassword } from '../api/users';
import { useToastStore } from '../stores/toast';

// 個人設定画面(SC-06・デザインhandoff components.md)。アカウント情報表示とパスワード変更

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
    <div className="mx-auto max-w-[760px] p-8">
      <h1 className="text-h1 font-bold text-ink">個人設定</h1>

      {currentUser && (
        <div className="mt-4 max-w-sm rounded border border-line bg-panel p-4 text-sm">
          <dl className="space-y-1">
            <div className="flex gap-2">
              <dt className="w-20 flex-shrink-0 text-ink-faint">ユーザーID</dt>
              <dd className="text-ink">{currentUser.username}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 flex-shrink-0 text-ink-faint">表示名</dt>
              <dd className="text-ink">{currentUser.displayName}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 flex-shrink-0 text-ink-faint">ロール</dt>
              <dd className="text-ink">{currentUser.role === 'admin' ? '管理者' : '一般'}</dd>
            </div>
          </dl>
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 max-w-sm space-y-3">
        <h2 className="text-sm font-bold text-ink">パスワード変更</h2>

        <label className="block text-sm text-ink-soft">
          現在のパスワード
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="mt-1 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          />
        </label>
        <label className="block text-sm text-ink-soft">
          新しいパスワード
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="mt-1 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          />
        </label>
        <label className="block text-sm text-ink-soft">
          新しいパスワード(確認)
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="mt-1 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          />
        </label>

        {error && (
          <p data-testid="password-error" className="text-sm text-danger">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-60"
        >
          変更する
        </button>
      </form>
    </div>
  );
}
