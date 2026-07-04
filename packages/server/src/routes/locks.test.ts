import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';

// 編集ロック・下書きAPIのテスト(FR-LOCK / FR-EDIT-08)
// 2ユーザー(yamada / suzuki)+adminで排他制御を検証する

const CSRF = { 'x-requested-with': 'TsumiWiki' };

type App = ReturnType<typeof buildApp>;
let app: App;
let lib: string;
let yamada: string;
let suzuki: string;
let admin: string;
let docPath: string;

async function loginAs(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: CSRF,
    payload: { username, password },
  });
  return (res.headers['set-cookie'] as string).split(';')[0];
}

function apiAs(
  cookie: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return app.inject({ method, url, headers: { ...CSRF, cookie }, payload: payload as never });
}

beforeEach(async () => {
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-locks-'));
  const config = loadConfig({ LIBRARY_PATH: lib, LOCK_TIMEOUT_MINUTES: '30' });
  const db = openDatabase(':memory:');
  app = buildApp({ config, db, logger: false });
  await app.ready();
  app.userService.create({ username: 'yamada', displayName: '山田', password: 'p', role: 'user' });
  app.userService.create({ username: 'suzuki', displayName: '鈴木', password: 'p', role: 'user' });
  app.userService.create({ username: 'admin', displayName: '管理者', password: 'p', role: 'admin' });
  yamada = await loginAs('yamada', 'p');
  suzuki = await loginAs('suzuki', 'p');
  admin = await loginAs('admin', 'p');

  const created = await apiAs(yamada, 'POST', '/api/docs', { folder: '', title: '共有文書' });
  docPath = created.json().path;
});

afterEach(async () => {
  await app.close();
  await rm(lib, { recursive: true, force: true });
});

describe('編集ロック', () => {
  it('ロック取得中は他ユーザーが取得できず、編集者名が返る', async () => {
    const got = await apiAs(yamada, 'POST', '/api/locks', { path: docPath });
    expect(got.statusCode).toBe(200);
    expect(got.json().lock.displayName).toBe('山田');

    const denied = await apiAs(suzuki, 'POST', '/api/locks', { path: docPath });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error.code).toBe('DOC_LOCKED');
    expect(denied.json().error.message).toContain('山田');

    // 文書取得にもロック情報が載る(FR-LOCK-01)
    const doc = await apiAs(suzuki, 'GET', `/api/docs?path=${encodeURIComponent(docPath)}`);
    expect(doc.json().lock.displayName).toBe('山田');
  }, 20_000);

  it('ロックなしの保存はLOCK_EXPIRED', async () => {
    const doc = await apiAs(yamada, 'GET', `/api/docs?path=${encodeURIComponent(docPath)}`);
    const res = await apiAs(yamada, 'PUT', '/api/docs', {
      path: docPath,
      body: 'x',
      baseUpdatedAt: doc.json().updatedAt,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LOCK_EXPIRED');
  }, 20_000);

  it('他ユーザーのロック中は保存・削除・移動が拒否される', async () => {
    await apiAs(yamada, 'POST', '/api/locks', { path: docPath });
    const doc = await apiAs(suzuki, 'GET', `/api/docs?path=${encodeURIComponent(docPath)}`);

    const save = await apiAs(suzuki, 'PUT', '/api/docs', {
      path: docPath,
      body: 'x',
      baseUpdatedAt: doc.json().updatedAt,
    });
    expect(save.json().error.code).toBe('DOC_LOCKED');

    const del = await apiAs(suzuki, 'DELETE', `/api/docs?path=${encodeURIComponent(docPath)}`);
    expect(del.json().error.code).toBe('DOC_LOCKED');

    const move = await apiAs(suzuki, 'POST', '/api/docs/move', {
      path: docPath,
      newFolder: '',
      newTitle: '奪取',
    });
    expect(move.json().error.code).toBe('DOC_LOCKED');
  }, 20_000);

  it('解放すると他ユーザーが取得できる', async () => {
    await apiAs(yamada, 'POST', '/api/locks', { path: docPath });
    await apiAs(yamada, 'DELETE', `/api/locks?path=${encodeURIComponent(docPath)}`);
    const got = await apiAs(suzuki, 'POST', '/api/locks', { path: docPath });
    expect(got.statusCode).toBe(200);
  }, 20_000);

  it('タイムアウトしたロックは無効になり、他ユーザーが取得できる(FR-LOCK-03)', async () => {
    await apiAs(yamada, 'POST', '/api/locks', { path: docPath });
    // refreshed_atを31分前に細工
    app.db
      .prepare('UPDATE locks SET refreshed_at = ?')
      .run(new Date(Date.now() - 31 * 60_000).toISOString());

    const got = await apiAs(suzuki, 'POST', '/api/locks', { path: docPath });
    expect(got.statusCode).toBe(200);
    expect(got.json().lock.displayName).toBe('鈴木');
  }, 20_000);

  it('ハートビートでrefreshed_atが更新される', async () => {
    await apiAs(yamada, 'POST', '/api/locks', { path: docPath });
    const before = app.db.prepare('SELECT refreshed_at FROM locks').get() as {
      refreshed_at: string;
    };
    app.db
      .prepare('UPDATE locks SET refreshed_at = ?')
      .run(new Date(Date.now() - 60_000).toISOString());

    const res = await apiAs(yamada, 'PUT', '/api/locks/refresh', { path: docPath });
    expect(res.statusCode).toBe(200);
    const after = app.db.prepare('SELECT refreshed_at FROM locks').get() as {
      refreshed_at: string;
    };
    expect(Date.parse(after.refreshed_at)).toBeGreaterThanOrEqual(Date.parse(before.refreshed_at));
  }, 20_000);

  it('adminは強制解除でき、一般ユーザーはできない(FR-LOCK-04)', async () => {
    await apiAs(yamada, 'POST', '/api/locks', { path: docPath });

    const denied = await apiAs(suzuki, 'DELETE', `/api/locks/force?path=${encodeURIComponent(docPath)}`);
    expect(denied.statusCode).toBe(403);

    const forced = await apiAs(admin, 'DELETE', `/api/locks/force?path=${encodeURIComponent(docPath)}`);
    expect(forced.statusCode).toBe(200);
    const got = await apiAs(suzuki, 'POST', '/api/locks', { path: docPath });
    expect(got.statusCode).toBe(200);
  }, 20_000);

  it('リネームするとロックが新パスへ追随する', async () => {
    await apiAs(yamada, 'POST', '/api/locks', { path: docPath });
    const moved = await apiAs(yamada, 'POST', '/api/docs/move', {
      path: docPath,
      newFolder: '',
      newTitle: '改名後',
    });
    const newPath = moved.json().path;

    // 他ユーザーは新パスでもロックに阻まれる
    const denied = await apiAs(suzuki, 'POST', '/api/locks', { path: newPath });
    expect(denied.json().error.code).toBe('DOC_LOCKED');
  }, 20_000);
});

describe('下書き(自動保存)', () => {
  it('ロック保持者は下書きを保存でき、明示保存で消える', async () => {
    await apiAs(yamada, 'POST', '/api/locks', { path: docPath });
    const put = await apiAs(yamada, 'PUT', '/api/drafts', {
      path: docPath,
      content: '書きかけの内容',
    });
    expect(put.statusCode).toBe(200);

    const got = await apiAs(yamada, 'GET', `/api/drafts?path=${encodeURIComponent(docPath)}`);
    expect(got.json().draft.content).toBe('書きかけの内容');

    // 他ユーザーには見えない
    const other = await apiAs(suzuki, 'GET', `/api/drafts?path=${encodeURIComponent(docPath)}`);
    expect(other.json().draft).toBeNull();

    // 明示保存で下書きが消える(FR-EDIT-08)
    const doc = await apiAs(yamada, 'GET', `/api/docs?path=${encodeURIComponent(docPath)}`);
    await apiAs(yamada, 'PUT', '/api/docs', {
      path: docPath,
      body: '確定した内容',
      baseUpdatedAt: doc.json().updatedAt,
    });
    const after = await apiAs(yamada, 'GET', `/api/drafts?path=${encodeURIComponent(docPath)}`);
    expect(after.json().draft).toBeNull();
  }, 20_000);

  it('ロックなしの下書き保存はLOCK_EXPIRED', async () => {
    const res = await apiAs(yamada, 'PUT', '/api/drafts', { path: docPath, content: 'x' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LOCK_EXPIRED');
  }, 20_000);
});
