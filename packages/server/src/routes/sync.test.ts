import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYNC_DOCS_MAX_PATHS } from '@tsumiwiki/shared';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';

// オフライン同期API(GET /api/sync/manifest, POST /api/sync/docs)のテスト
// 設計07章7.4のマニフェスト突合方式に沿っているかを検証する

const CSRF = { 'x-requested-with': 'TsumiWiki' };

type App = ReturnType<typeof buildApp>;
let app: App;
let lib: string;
let cookie: string;

function api(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({ method, url, headers: { ...CSRF, cookie }, payload: payload as never });
}

beforeEach(async () => {
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-sync-'));
  const config = loadConfig({ LIBRARY_PATH: lib });
  const db = openDatabase(':memory:');
  app = buildApp({ config, db, logger: false });
  await app.ready();
  app.userService.create({ username: 'yamada', displayName: '山田 太郎', password: 'pass', role: 'user' });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: CSRF,
    payload: { username: 'yamada', password: 'pass' },
  });
  cookie = (login.headers['set-cookie'] as string).split(';')[0];

  await writeFile(
    join(lib, '設計方針.md'),
    '---\ntags: [設計, 重要]\n---\n\nデータベースのスキーマ設計について記述する。 #アーキテクチャ\n',
    'utf8',
  );
  await writeFile(join(lib, '買い物メモ.md'), '---\ntags: [メモ]\n---\n\n牛乳と卵を買う。\n', 'utf8');
  await app.indexerService.scanAll();
});

afterEach(async () => {
  await app.close();
  await rm(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('GET /api/sync/manifest', () => {
  it('全文書のパス・更新日時・サイズが過不足なく取れる', async () => {
    const res = await api('GET', '/api/sync/manifest');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(2);
    const paths = body.docs.map((d: { path: string }) => d.path).sort();
    expect(paths).toEqual(['設計方針.md', '買い物メモ.md'].sort());
    for (const entry of body.docs) {
      expect(typeof entry.updatedAt).toBe('string');
      expect(typeof entry.size).toBe('number');
      expect(entry.size).toBeGreaterThan(0);
    }
  });

  it('ETagが付与され、同じETagをIf-None-Matchで送ると304(本文なし)が返る', async () => {
    const first = await api('GET', '/api/sync/manifest');
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();

    const second = await app.inject({
      method: 'GET',
      url: '/api/sync/manifest',
      headers: { ...CSRF, cookie, 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('1件保存後はETagが変わり、その文書のupdatedAtが更新される', async () => {
    const before = await api('GET', '/api/sync/manifest');
    const etagBefore = before.headers.etag as string;
    const beforeEntry = before.json().docs.find((d: { path: string }) => d.path === '設計方針.md');

    await api('POST', '/api/locks', { path: '設計方針.md' });
    const saved = await api('PUT', '/api/docs', {
      path: '設計方針.md',
      body: '更新後の本文',
      tags: ['設計'],
      baseUpdatedAt: beforeEntry.updatedAt,
    });
    expect(saved.statusCode).toBe(200);

    const after = await api('GET', '/api/sync/manifest');
    expect(after.headers.etag).not.toBe(etagBefore);
    const afterEntry = after.json().docs.find((d: { path: string }) => d.path === '設計方針.md');
    expect(afterEntry.updatedAt).not.toBe(beforeEntry.updatedAt);
  });

  it('1件削除後はETagが変わり、その文書がマニフェストから消える', async () => {
    const before = await api('GET', '/api/sync/manifest');
    const etagBefore = before.headers.etag as string;

    const deleted = await api('DELETE', `/api/docs?path=${encodeURIComponent('買い物メモ.md')}`);
    expect(deleted.statusCode).toBe(200);

    const after = await api('GET', '/api/sync/manifest');
    expect(after.headers.etag).not.toBe(etagBefore);
    const paths = after.json().docs.map((d: { path: string }) => d.path);
    expect(paths).not.toContain('買い物メモ.md');
  });

  it('外部変更の取り込み(indexerServiceによるインデックス更新)でもETagが変わる', async () => {
    const before = await api('GET', '/api/sync/manifest');
    const etagBefore = before.headers.etag as string;

    // library-watcher/sync-serviceが外部変更を取り込む経路を模す:
    // APIを経由せず直接ファイルを書き換えてインデックスだけ更新する
    await writeFile(
      join(lib, '設計方針.md'),
      '---\ntags: [設計, 重要]\n---\n\n外部から書き換えられた本文。\n',
      'utf8',
    );
    await app.indexerService.indexFile('設計方針.md');

    const after = await api('GET', '/api/sync/manifest');
    expect(after.headers.etag).not.toBe(etagBefore);
  });
});

describe('POST /api/sync/docs', () => {
  it('指定パスの本文・タイトル・フォルダ・タグが取れ、本文にフロントマターが含まれない', async () => {
    const res = await api('POST', '/api/sync/docs', { paths: ['設計方針.md'] });
    expect(res.statusCode).toBe(200);
    const { docs } = res.json();
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc.path).toBe('設計方針.md');
    expect(doc.title).toBe('設計方針');
    expect(doc.folder).toBe('');
    expect(doc.body).not.toContain('---');
    expect(doc.body).not.toContain('tags:');
    expect(doc.body).toContain('データベースのスキーマ設計について記述する。');
    expect(doc.tags.sort()).toEqual(['アーキテクチャ', '設計', '重要'].sort());
  });

  it(`pathsが${SYNC_DOCS_MAX_PATHS + 1}件のとき400になる`, async () => {
    const paths = Array.from({ length: SYNC_DOCS_MAX_PATHS + 1 }, (_, i) => `x${i}.md`);
    const res = await api('POST', '/api/sync/docs', { paths });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('pathsが0件のとき400になる', async () => {
    const res = await api('POST', '/api/sync/docs', { paths: [] });
    expect(res.statusCode).toBe(400);
  });

  it('存在しないパスを含めても200で、存在する分だけが返る', async () => {
    const res = await api('POST', '/api/sync/docs', {
      paths: ['設計方針.md', '存在しない文書.md'],
    });
    expect(res.statusCode).toBe(200);
    const { docs } = res.json();
    expect(docs.map((d: { path: string }) => d.path)).toEqual(['設計方針.md']);
  });
});

describe('認証・CSRF', () => {
  it('未認証ではmanifestが401になる', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sync/manifest' });
    expect(res.statusCode).toBe(401);
  });

  it('未認証ではdocsが401になる', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/docs',
      headers: CSRF,
      payload: { paths: ['設計方針.md'] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('X-Requested-Withなしのdocs POSTは403になる', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/docs',
      headers: { cookie },
      payload: { paths: ['設計方針.md'] },
    });
    expect(res.statusCode).toBe(403);
  });
});
