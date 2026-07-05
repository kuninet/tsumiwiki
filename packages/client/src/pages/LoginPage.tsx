import { type FormEvent, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiRequestError } from '../api/client';
import { useLogin } from '../api/auth';

// ログイン画面(SC-01・設計04章4.2・デザインhandoff components.md)

export function LoginPage() {
  const usernameId = useId();
  const passwordId = useId();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const navigate = useNavigate();
  const login = useLogin();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (login.isPending) return; // Enterキー連打の二重送信ガード
    setErrorMessage(null);
    login.mutate(
      { username, password },
      {
        onSuccess: () => navigate('/', { replace: true }),
        onError: (err) => {
          setErrorMessage(
            err instanceof ApiRequestError ? err.message : 'ログインに失敗しました',
          );
        },
      },
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas font-sans">
      <form
        onSubmit={handleSubmit}
        className="w-80 rounded-lg border border-line bg-panel p-8 shadow"
      >
        <div className="mb-6 flex flex-col items-center gap-2">
          <span
            aria-hidden="true"
            style={{ background: 'var(--tw-accent-gradient)' }}
            className="flex h-[26px] w-[26px] items-center justify-center rounded text-sm font-bold text-white"
          >
            積
          </span>
          <h1 className="text-h1 font-bold text-ink">TsumiWiki</h1>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor={usernameId} className="block text-sm font-medium text-ink-soft">
              ユーザーID
            </label>
            <input
              id={usernameId}
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-1 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor={passwordId} className="block text-sm font-medium text-ink-soft">
              パスワード
            </label>
            <input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </div>
        </div>

        {errorMessage && (
          <p data-testid="login-error" className="mt-4 text-sm text-danger">
            {errorMessage}
          </p>
        )}

        <button
          type="submit"
          disabled={login.isPending}
          className="mt-6 w-full rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60"
        >
          ログイン
        </button>
      </form>
    </div>
  );
}
