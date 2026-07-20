import { type FormEvent, useState } from 'react';
import { useMe } from '../api/auth';
import { ApiRequestError } from '../api/client';
import { changeMyPassword } from '../api/users';
import { useToastStore } from '../stores/toast';
import { useUserSettingsStore, type NewDocPolicy } from '../stores/user-settings';

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

      <NewDocSettings />
    </div>
  );
}

// #138 Phase C-2: 新規文書の作成先ポリシー設定。
// 設定はブラウザローカル(zustand/persist)。将来サーバ side に移してもよい
function NewDocSettings() {
  const policy = useUserSettingsStore((s) => s.newDocPolicy);
  const fixedFolder = useUserSettingsStore((s) => s.fixedFolder);
  const setPolicy = useUserSettingsStore((s) => s.setNewDocPolicy);
  const setFixedFolder = useUserSettingsStore((s) => s.setFixedFolder);

  function radio(value: NewDocPolicy, label: string, description: string) {
    return (
      <label className="flex cursor-pointer items-start gap-2 rounded border border-line p-3 text-sm hover:bg-hoverbg">
        <input
          type="radio"
          name="new-doc-policy"
          value={value}
          checked={policy === value}
          onChange={() => setPolicy(value)}
          className="mt-1"
        />
        <span>
          <span className="font-medium text-ink">{label}</span>
          <span className="mt-0.5 block text-xs text-ink-faint">{description}</span>
        </span>
      </label>
    );
  }

  return (
    <section className="mt-8 max-w-md space-y-3">
      <h2 className="text-sm font-bold text-ink">新規文書の作成先</h2>
      <p className="text-xs text-ink-faint">
        Ctrl+N(⌘N)や「+新規文書」で新しく文書を作るとき、どのフォルダを初期値にするかを選びます。
      </p>
      <div className="space-y-2">
        {radio(
          'same-folder',
          '表示中の文書と同じフォルダ',
          '現在アクティブなタブの文書があるフォルダ。ルート直下ならルート',
        )}
        {radio('fixed-folder', '特定のフォルダ', '下で指定したフォルダを常に初期値にする')}
        {radio('root', 'ルート', '常にライブラリのルート直下に作る')}
      </div>
      {policy === 'fixed-folder' && (
        <label className="block text-sm text-ink-soft">
          固定フォルダのパス(例: 日誌 / 業務/週次)
          <input
            type="text"
            value={fixedFolder}
            onChange={(e) => setFixedFolder(e.target.value)}
            placeholder="(ルート)"
            className="mt-1 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          />
        </label>
      )}
    </section>
  );
}
