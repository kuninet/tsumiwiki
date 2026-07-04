import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';

// 認証・ユーザー管理APIのテスト(FR-AUTH一式)

const CSRF = { 'x-requested-with': 'TsumiWiki' };

type App = ReturnType<typeof buildApp>;
let app: App;

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: CSRF,
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers['set-cookie'] as string;
  return setCookie.split(';')[0]; // tsumiwiki_sid=...
}

beforeEach(async () => {
  const config = loadConfig({ LIBRARY_PATH: mkdtempSync(join(tmpdir(), 'tsumiwiki-auth-')) });
  const db = openDatabase(':memory:');
  app = buildApp({ config, db, logger: false });
  await app.ready();
  app.userService.create({
    username: 'admin',
    displayName: '管理者',
    password: 'admin-pass',
    role: 'admin',
  });
  app.userService.create({
    username: 'yamada',
    displayName: '山田 太郎',
    password: 'yamada-pass',
    role: 'user',
  });
});

describe('認証', () => {
  it('ログイン→me→ログアウトの一連が動作する', async () => {
    const cookie = await login('yamada', 'yamada-pass');

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.displayName).toBe('山田 太郎');

    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...CSRF, cookie },
    });
    expect(out.statusCode).toBe(200);

    const meAfter = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(meAfter.statusCode).toBe(401);
  });

  it('パスワード誤りは401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: CSRF,
      payload: { username: 'yamada', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('無効化ユーザーはログインできない', async () => {
    const admin = await login('admin', 'admin-pass');
    const users = app.userService.list();
    const yamada = users.find((u) => u.username === 'yamada')!;
    await app.inject({
      method: 'PATCH',
      url: `/api/users/${yamada.id}`,
      headers: { ...CSRF, cookie: admin },
      payload: { disabled: true },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: CSRF,
      payload: { username: 'yamada', password: 'yamada-pass' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('未認証アクセスは401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('CSRFヘッダなしの変更系リクエストは403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'yamada', password: 'yamada-pass' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('期限切れセッションは無効', async () => {
    const cookie = await login('yamada', 'yamada-pass');
    const sid = cookie.split('=')[1];
    app.db
      .prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), sid);

    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });

  it('ログイン中に無効化されたユーザーは次のリクエストで401(遅延失効)', async () => {
    const cookie = await login('yamada', 'yamada-pass');
    const admin = await login('admin', 'admin-pass');
    const yamada = app.userService.list().find((u) => u.username === 'yamada')!;
    await app.inject({
      method: 'PATCH',
      url: `/api/users/${yamada.id}`,
      headers: { ...CSRF, cookie: admin },
      payload: { disabled: true },
    });

    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });

  it('残りTTLが半分を切るとセッションが延長される(スライディング)', async () => {
    const cookie = await login('yamada', 'yamada-pass');
    const sid = cookie.split('=')[1];
    // 残り10分(TTL480分の半分未満)に細工
    const nearExpiry = new Date(Date.now() + 10 * 60_000).toISOString();
    app.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(nearExpiry, sid);

    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const row = app.db.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(sid) as {
      expires_at: string;
    };
    expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.parse(nearExpiry));
    // Cookieの有効期限も再発行される
    expect(res.headers['set-cookie']).toContain('Max-Age');
  });

  it('連続ログイン失敗でレート制限がかかる(429)', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: CSRF,
        payload: { username: 'ratelimit-user', password: 'wrong' },
      });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: CSRF,
      payload: { username: 'ratelimit-user', password: 'wrong' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('TOO_MANY_REQUESTS');
  });
});

describe('ユーザー管理(admin)', () => {
  it('adminはユーザーを追加・更新できる', async () => {
    const admin = await login('admin', 'admin-pass');

    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { ...CSRF, cookie: admin },
      payload: { username: 'suzuki', displayName: '鈴木', password: 'suzuki-pass', role: 'user' },
    });
    expect(created.statusCode).toBe(201);

    const listed = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin } });
    expect(listed.json().users).toHaveLength(3);

    const dup = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { ...CSRF, cookie: admin },
      payload: { username: 'suzuki', displayName: '鈴木2', password: 'x' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('一般ユーザーはユーザー管理APIにアクセスできない', async () => {
    const cookie = await login('yamada', 'yamada-pass');
    const res = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie } });
    expect(res.statusCode).toBe(403);

    const yamada = app.userService.list().find((u) => u.username === 'yamada')!;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/users/${yamada.id}`,
      headers: { ...CSRF, cookie },
      payload: { role: 'admin' },
    });
    expect(patch.statusCode).toBe(403);
  });

  it('CSRFヘッダなしのユーザー作成は403', async () => {
    const admin = await login('admin', 'admin-pass');
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: admin },
      payload: { username: 'x', displayName: 'x', password: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('自分自身の無効化・降格は拒否される', async () => {
    const admin = await login('admin', 'admin-pass');
    const adminUser = app.userService.list().find((u) => u.username === 'admin')!;

    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminUser.id}`,
      headers: { ...CSRF, cookie: admin },
      payload: { disabled: true },
    });
    expect(disable.statusCode).toBe(400);

    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminUser.id}`,
      headers: { ...CSRF, cookie: admin },
      payload: { role: 'user' },
    });
    expect(demote.statusCode).toBe(400);
  });

  it('無効化されたユーザーのセッションは即時失効する', async () => {
    const yamadaCookie = await login('yamada', 'yamada-pass');
    const admin = await login('admin', 'admin-pass');
    const yamada = app.userService.list().find((u) => u.username === 'yamada')!;
    await app.inject({
      method: 'PATCH',
      url: `/api/users/${yamada.id}`,
      headers: { ...CSRF, cookie: admin },
      payload: { disabled: true },
    });
    // セッション自体が削除されている
    const sid = yamadaCookie.split('=')[1];
    const row = app.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sid);
    expect(row).toBeUndefined();
  });
});

describe('パスワード変更', () => {
  it('本人がパスワードを変更でき、新パスワードでログインできる', async () => {
    const cookie = await login('yamada', 'yamada-pass');

    const changed = await app.inject({
      method: 'PUT',
      url: '/api/me/password',
      headers: { ...CSRF, cookie },
      payload: { currentPassword: 'yamada-pass', newPassword: 'new-pass' },
    });
    expect(changed.statusCode).toBe(200);

    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: CSRF,
      payload: { username: 'yamada', password: 'yamada-pass' },
    });
    expect(oldLogin.statusCode).toBe(401);

    await login('yamada', 'new-pass');
  });

  it('パスワード変更で本人の他セッションが失効する(現行セッションは維持)', async () => {
    const cookie1 = await login('yamada', 'yamada-pass');
    const cookie2 = await login('yamada', 'yamada-pass');

    const changed = await app.inject({
      method: 'PUT',
      url: '/api/me/password',
      headers: { ...CSRF, cookie: cookie1 },
      payload: { currentPassword: 'yamada-pass', newPassword: 'new-pass' },
    });
    expect(changed.statusCode).toBe(200);

    const me1 = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookie1 } });
    expect(me1.statusCode).toBe(200);
    const me2 = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookie2 } });
    expect(me2.statusCode).toBe(401);
  });

  it('現在のパスワードが違うと変更できない', async () => {
    const cookie = await login('yamada', 'yamada-pass');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/me/password',
      headers: { ...CSRF, cookie },
      payload: { currentPassword: 'wrong', newPassword: 'new-pass' },
    });
    expect(res.statusCode).toBe(400);
  });
});
