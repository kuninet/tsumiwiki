import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, api } from './client';

// APIクライアント単体テスト(#29レビュー指摘の回帰)

function stubFetch(status: number, body: unknown, contentType = 'application/json') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': contentType },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api()', () => {
  it('保護APIの401でセッション失効イベントが発火する', async () => {
    stubFetch(401, { error: { code: 'UNAUTHORIZED', message: 'ログインが必要です' } });
    const listener = vi.fn();
    window.addEventListener('tsumiwiki:unauthorized', listener);

    await expect(api('GET', '/api/tree')).rejects.toThrow(ApiRequestError);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('tsumiwiki:unauthorized', listener);
  });

  it('ログイン失敗の401ではイベントを発火しない(誤リダイレクト防止)', async () => {
    stubFetch(401, { error: { code: 'UNAUTHORIZED', message: 'IDまたはパスワードが違います' } });
    const listener = vi.fn();
    window.addEventListener('tsumiwiki:unauthorized', listener);

    await expect(api('POST', '/api/auth/login', { username: 'a', password: 'b' })).rejects.toThrow(
      ApiRequestError,
    );
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('tsumiwiki:unauthorized', listener);
  });

  it('エラー応答が非JSONでも汎用ApiRequestErrorになる', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Internal Server Error', { status: 500 })),
    );
    const err = await api('GET', '/api/tree').catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).code).toBe('UNKNOWN_ERROR');
  });

  it('204・空ボディの成功応答で例外にならない', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api('DELETE', '/api/locks?path=x.md')).resolves.toBeUndefined();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
    await expect(api('GET', '/api/tree')).resolves.toBeUndefined();
  });

  it('CSRFヘッダとcredentialsが常に付与される', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api('GET', '/api/tree');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-Requested-With']).toBe('TsumiWiki');
    expect(init.credentials).toBe('same-origin');
  });
});
