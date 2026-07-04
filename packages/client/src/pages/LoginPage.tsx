import { type FormEvent, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiRequestError } from '../api/client';
import { useLogin } from '../api/auth';

// ログイン画面(SC-01・設計04章4.2)

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
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <form
        onSubmit={handleSubmit}
        className="w-80 rounded-lg border border-gray-200 bg-white p-8 shadow-sm"
      >
        <h1 className="mb-6 text-center text-2xl font-bold text-gray-800">TsumiWiki</h1>

        <div className="space-y-4">
          <div>
            <label htmlFor={usernameId} className="block text-sm font-medium text-gray-700">
              ユーザーID
            </label>
            <input
              id={usernameId}
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor={passwordId} className="block text-sm font-medium text-gray-700">
              パスワード
            </label>
            <input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>

        {errorMessage && (
          <p data-testid="login-error" className="mt-4 text-sm text-red-600">
            {errorMessage}
          </p>
        )}

        <button
          type="submit"
          disabled={login.isPending}
          className="mt-6 w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          ログイン
        </button>
      </form>
    </div>
  );
}
