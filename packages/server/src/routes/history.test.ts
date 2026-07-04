import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';

// 履歴APIのテスト(FR-HIST一式)

const CSRF = { 'x-requested-with': 'TsumiWiki' };

type App = ReturnType<typeof buildApp>;
let app: App;
let lib: string;
let cookie: string;
let docPath: string;

function api(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({ method, url, headers: { ...CSRF, cookie }, payload: payload as never });
}

async function save(body: string) {
  await api('POST', '/api/locks', { path: docPath });
  const doc = await api('GET', `/api/docs?path=${encodeURIComponent(docPath)}`);
  const res = await api('PUT', '/api/docs', {
    path: docPath,
    body,
    baseUpdatedAt: doc.json().updatedAt,
  });
  expect(res.statusCode).toBe(200);
}

beforeEach(async () => {
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-hist-'));
  const config = loadConfig({ LIBRARY_PATH: lib });
  const db = openDatabase(':memory:');
  app = buildApp({ config, db, logger: false });
  await app.ready();
  app.userService.create({ username: 'yamada', displayName: '山田', password: 'p', role: 'user' });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: CSRF,
    payload: { username: 'yamada', password: 'p' },
  });
  cookie = (login.headers['set-cookie'] as string).split(';')[0];

  const created = await api('POST', '/api/docs', { folder: '', title: '履歴文書' });
  docPath = created.json().path;
  await save('第1版の内容');
  await save('第2版の内容');
});

afterEach(async () => {
  await app.close();
  await rm(lib, { recursive: true, force: true });
});

describe('履歴API', () => {
  it('履歴一覧が新しい順に返り、編集者が記録されている(FR-HIST-02)', async () => {
    const res = await api('GET', `/api/history?path=${encodeURIComponent(docPath)}`);
    expect(res.statusCode).toBe(200);
    const history = res.json().history;
    expect(history.length).toBe(3); // add + edit x2
    expect(history[0].message).toBe(`edit: ${docPath}`);
    expect(history[2].message).toBe(`add: ${docPath}`);
    expect(history[0].authorName).toBe('山田');
  }, 30_000);

  it('過去版の内容と差分を取得できる(FR-HIST-03)', async () => {
    const history = (await api('GET', `/api/history?path=${encodeURIComponent(docPath)}`)).json()
      .history;
    const firstEdit = history[1].rev;

    const content = await api(
      'GET',
      `/api/history/content?path=${encodeURIComponent(docPath)}&rev=${firstEdit}`,
    );
    expect(content.json().content).toContain('第1版の内容');

    const diff = await api(
      'GET',
      `/api/history/diff?path=${encodeURIComponent(docPath)}&rev=${firstEdit}`,
    );
    expect(diff.json().diff).toContain('-第1版の内容');
    expect(diff.json().diff).toContain('+第2版の内容');
  }, 30_000);

  it('過去版を復元でき、履歴は巻き戻らず新しいコミットが積まれる(FR-HIST-04)', async () => {
    const history = (await api('GET', `/api/history?path=${encodeURIComponent(docPath)}`)).json()
      .history;
    const firstEdit = history[1].rev;

    await api('POST', '/api/locks', { path: docPath });
    const restored = await api('POST', '/api/history/restore', {
      path: docPath,
      rev: firstEdit,
    });
    expect(restored.statusCode).toBe(200);

    const doc = await api('GET', `/api/docs?path=${encodeURIComponent(docPath)}`);
    expect(doc.json().body).toContain('第1版の内容');

    const after = (await api('GET', `/api/history?path=${encodeURIComponent(docPath)}`)).json()
      .history;
    expect(after.length).toBe(4);
    expect(after[0].message).toBe(`restore: ${docPath} @${firstEdit.slice(0, 7)}`);
  }, 30_000);

  it('ロックなしの復元はLOCK_EXPIRED', async () => {
    const history = (await api('GET', `/api/history?path=${encodeURIComponent(docPath)}`)).json()
      .history;
    // ロックを解放してから復元を試みる
    await api('DELETE', `/api/locks?path=${encodeURIComponent(docPath)}`);
    const res = await api('POST', '/api/history/restore', {
      path: docPath,
      rev: history[1].rev,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LOCK_EXPIRED');
  }, 30_000);

  it('存在しない版の内容取得は404', async () => {
    const res = await api(
      'GET',
      `/api/history/content?path=${encodeURIComponent(docPath)}&rev=deadbeef`,
    );
    expect(res.statusCode).toBe(404);
  }, 30_000);

  it('不正なrev形式は400', async () => {
    const res = await api(
      'GET',
      `/api/history/content?path=${encodeURIComponent(docPath)}&rev=..%2Fetc`,
    );
    expect(res.statusCode).toBe(400);
  }, 30_000);
});

describe('レビュー指摘の回帰テスト', () => {
  it('against指定で2版間の差分が取れる', async () => {
    const history = (await api('GET', `/api/history?path=${encodeURIComponent(docPath)}`)).json()
      .history;
    const oldest = history[2].rev; // add:(空)
    const first = history[1].rev; // 第1版

    const diff = await api(
      'GET',
      `/api/history/diff?path=${encodeURIComponent(docPath)}&rev=${oldest}&against=${first}`,
    );
    expect(diff.statusCode).toBe(200);
    expect(diff.json().diff).toContain('+第1版の内容');
  }, 30_000);

  it('他ユーザーがロック保持中の復元はDOC_LOCKED', async () => {
    app.userService.create({ username: 'suzuki', displayName: '鈴木', password: 'p', role: 'user' });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: CSRF,
      payload: { username: 'suzuki', password: 'p' },
    });
    const suzuki = (login.headers['set-cookie'] as string).split(';')[0];
    // セットアップでyamadaが保持しているロックを解放してから鈴木が取得する
    await api('DELETE', `/api/locks?path=${encodeURIComponent(docPath)}`);
    const acquired = await app.inject({
      method: 'POST',
      url: '/api/locks',
      headers: { ...CSRF, cookie: suzuki },
      payload: { path: docPath },
    });
    expect(acquired.statusCode).toBe(200);

    const history = (await api('GET', `/api/history?path=${encodeURIComponent(docPath)}`)).json()
      .history;
    const res = await api('POST', '/api/history/restore', { path: docPath, rev: history[1].rev });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DOC_LOCKED');
  }, 30_000);

  it('保護パスの履歴取得は400', async () => {
    const res = await api('GET', `/api/history?path=${encodeURIComponent('.obsidian/app.md')}`);
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it('有効なrevでも当該版にパスが存在しなければ404', async () => {
    const history = (await api('GET', `/api/history?path=${encodeURIComponent(docPath)}`)).json()
      .history;
    // 最古の版よりさらに前には別文書は存在しない → 別文書を作って旧revで引く
    const other = await api('POST', '/api/docs', { folder: '', title: '後から作った文書' });
    const res = await api(
      'GET',
      `/api/history/content?path=${encodeURIComponent(other.json().path)}&rev=${history[2].rev}`,
    );
    expect(res.statusCode).toBe(404);
  }, 30_000);
});
