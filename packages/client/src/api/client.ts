import { apiErrorSchema } from '@tsumiwiki/shared';

// サーバー側のCSRF対策(X-Requested-With必須)に対応するAPIクライアント(設計01章1.5)

const CSRF_HEADER_VALUE = 'TsumiWiki';
const UNAUTHORIZED_EVENT = 'tsumiwiki:unauthorized';

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': CSRF_HEADER_VALUE,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    // 401イベントは「セッション失効」に限定する。ログイン失敗の401は
    // 認証情報の誤りでありリダイレクト対象ではない(#29レビュー対応)
    if (res.status === 401 && path !== '/api/auth/login') {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    const parsed = apiErrorSchema.safeParse(await res.json().catch(() => null));
    const code = parsed.success ? parsed.data.error.code : 'UNKNOWN_ERROR';
    const message = parsed.success ? parsed.data.error.message : 'エラーが発生しました';
    throw new ApiRequestError(res.status, code, message);
  }

  // 204や空ボディでも例外にしない(#29レビュー対応)
  if (res.status === 204) return undefined as T;
  return (await res.json().catch(() => undefined)) as T;
}
