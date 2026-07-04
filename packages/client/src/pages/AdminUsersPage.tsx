import { createUserRequestSchema, type User, type UserRole } from '@tsumiwiki/shared';
import { type FormEvent, useState } from 'react';
import { useMe } from '../api/auth';
import { useCreateUser, useUpdateUser, useUsers } from '../api/users';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PromptDialog } from '../components/PromptDialog';

// ユーザー管理画面(SC-05・FR-AUTH-02)。adminのみアクセス可能(ルーティング側でガード済み)

type PromptTarget =
  | { kind: 'displayName'; id: number; current: string }
  | { kind: 'password'; id: number }
  | null;

type ConfirmTarget = { kind: 'disable' | 'demote'; id: number; displayName: string } | null;

function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [error, setError] = useState<string | null>(null);
  const createUser = useCreateUser();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = createUserRequestSchema.safeParse({ username, displayName, password, role });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '入力内容を確認してください');
      return;
    }
    setError(null);
    createUser.mutate(parsed.data, { onSuccess: onClose });
  }

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <form onSubmit={handleSubmit} className="w-96 rounded-lg bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-bold text-gray-800">ユーザー追加</h2>

        <label className="block text-sm font-medium text-gray-700">
          ユーザーID
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="mt-3 block text-sm font-medium text-gray-700">
          表示名
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="mt-3 block text-sm font-medium text-gray-700">
          パスワード
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="mt-3 block text-sm font-medium text-gray-700">
          ロール
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="user">一般</option>
            <option value="admin">管理者</option>
          </select>
        </label>

        {error && (
          <p data-testid="create-user-error" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            キャンセル
          </button>
          <button
            type="submit"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
          >
            追加
          </button>
        </div>
      </form>
    </div>
  );
}

export function AdminUsersPage() {
  const { data: currentUser } = useMe();
  const { data: users, isLoading } = useUsers();
  const updateUser = useUpdateUser();
  const [createDialogVisible, setCreateDialogVisible] = useState(false);
  const [promptTarget, setPromptTarget] = useState<PromptTarget>(null);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget>(null);

  function handleToggleDisabled(user: User) {
    if (user.disabled) {
      updateUser.mutate({ id: user.id, body: { disabled: false } });
    } else {
      setConfirmTarget({ kind: 'disable', id: user.id, displayName: user.displayName });
    }
  }

  function handleToggleRole(user: User) {
    if (user.role === 'user') {
      updateUser.mutate({ id: user.id, body: { role: 'admin' } });
    } else {
      setConfirmTarget({ kind: 'demote', id: user.id, displayName: user.displayName });
    }
  }

  function handleConfirm() {
    if (!confirmTarget) return;
    if (confirmTarget.kind === 'disable') {
      updateUser.mutate({ id: confirmTarget.id, body: { disabled: true } });
    } else {
      updateUser.mutate({ id: confirmTarget.id, body: { role: 'user' } });
    }
    setConfirmTarget(null);
  }

  function handlePromptConfirm(value: string) {
    if (!promptTarget) return;
    if (promptTarget.kind === 'displayName') {
      updateUser.mutate({ id: promptTarget.id, body: { displayName: value } });
    } else {
      updateUser.mutate({ id: promptTarget.id, body: { password: value } });
    }
    setPromptTarget(null);
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-800">ユーザー管理</h1>
        <button
          type="button"
          onClick={() => setCreateDialogVisible(true)}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
        >
          ユーザー追加
        </button>
      </div>

      {isLoading && <p className="mt-4 text-sm text-gray-500">読み込み中...</p>}

      {!isLoading && (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-gray-500">
              <th className="py-2 font-medium">ID</th>
              <th className="py-2 font-medium">ユーザーID</th>
              <th className="py-2 font-medium">表示名</th>
              <th className="py-2 font-medium">ロール</th>
              <th className="py-2 font-medium">状態</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((user) => {
              const isSelf = user.id === currentUser?.id;
              const disablingIsSelf = isSelf && !user.disabled;
              const demotingIsSelf = isSelf && user.role === 'admin';
              return (
                <tr key={user.id} className="border-b border-gray-100">
                  <td className="py-2 text-gray-500">{user.id}</td>
                  <td className="py-2 text-gray-800">{user.username}</td>
                  <td className="py-2 text-gray-800">{user.displayName}</td>
                  <td className="py-2 text-gray-500">{user.role === 'admin' ? '管理者' : '一般'}</td>
                  <td className="py-2 text-gray-500">{user.disabled ? '無効' : '有効'}</td>
                  <td className="py-2 text-right">
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          setPromptTarget({ kind: 'displayName', id: user.id, current: user.displayName })
                        }
                        className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100"
                      >
                        表示名変更
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleRole(user)}
                        disabled={demotingIsSelf}
                        title={demotingIsSelf ? '自分自身は変更できません' : undefined}
                        className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {user.role === 'admin' ? '降格' : '昇格'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleDisabled(user)}
                        disabled={disablingIsSelf}
                        title={disablingIsSelf ? '自分自身は変更できません' : undefined}
                        className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {user.disabled ? '有効化' : '無効化'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPromptTarget({ kind: 'password', id: user.id })}
                        disabled={user.id === currentUser?.id}
                        title={
                          user.id === currentUser?.id
                            ? '自分のパスワードは個人設定から変更してください(ここで変更すると全セッションが失効します)'
                            : undefined
                        }
                        className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        パスワードリセット
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {createDialogVisible && <CreateUserDialog onClose={() => setCreateDialogVisible(false)} />}

      {promptTarget?.kind === 'displayName' && (
        <PromptDialog
          title="表示名の変更"
          label="表示名"
          defaultValue={promptTarget.current}
          confirmLabel="変更"
          onConfirm={handlePromptConfirm}
          onCancel={() => setPromptTarget(null)}
        />
      )}
      {promptTarget?.kind === 'password' && (
        <PromptDialog
          title="パスワードリセット"
          label="新しいパスワード"
          confirmLabel="リセット"
          inputType="password"
          autoComplete="new-password"
          onConfirm={handlePromptConfirm}
          onCancel={() => setPromptTarget(null)}
        />
      )}

      {confirmTarget?.kind === 'disable' && (
        <ConfirmDialog
          title="ユーザーの無効化"
          message={`「${confirmTarget.displayName}」を無効化します。よろしいですか?`}
          confirmLabel="無効化する"
          onConfirm={handleConfirm}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
      {confirmTarget?.kind === 'demote' && (
        <ConfirmDialog
          title="管理者権限の解除"
          message={`「${confirmTarget.displayName}」の管理者権限を解除します。よろしいですか?`}
          confirmLabel="降格する"
          onConfirm={handleConfirm}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
    </div>
  );
}
