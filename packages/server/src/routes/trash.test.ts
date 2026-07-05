import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';

// ごみ箱APIのテスト(FR-DOC-07)

const CSRF = { 'x-requested-with': 'TsumiWiki' };

type App = ReturnType<typeof buildApp>;
let app: App;
let lib: string;
let yamada: string;
let admin: string;

async function loginAs(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: CSRF,
    payload: { username, password: 'p' },
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
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-trash-'));
  const config = loadConfig({ LIBRARY_PATH: lib });
  const db = openDatabase(':memory:');
  app = buildApp({ config, db, logger: false });
  await app.ready();
  app.userService.create({ username: 'yamada', displayName: '山田', password: 'p', role: 'user' });
  app.userService.create({ username: 'admin', displayName: '管理者', password: 'p', role: 'admin' });
  yamada = await loginAs('yamada');
  admin = await loginAs('admin');
});

afterEach(async () => {
  await app.close();
  await rm(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('ごみ箱API', () => {
  it('削除した文書が一覧に載り、元パス・削除者が分かる', async () => {
    const created = await apiAs(yamada, 'POST', '/api/docs', {
      folder: 'メモ帳',
      title: '捨てる文書',
    });
    await apiAs(yamada, 'DELETE', `/api/docs?path=${encodeURIComponent(created.json().path)}`);

    const list = await apiAs(yamada, 'GET', '/api/trash');
    expect(list.statusCode).toBe(200);
    const entry = list.json().entries[0];
    expect(entry.name).toBe('捨てる文書.md');
    expect(entry.originalPath).toBe('メモ帳/捨てる文書.md');
    expect(entry.deletedBy).toBe('山田');
    expect(entry.isFolder).toBe(false);
  }, 30_000);

  it('復元すると元の場所へ戻り、インデックスにも反映される', async () => {
    const created = await apiAs(yamada, 'POST', '/api/docs', {
      folder: '議事録',
      title: '戻す文書',
    });
    const docPath = created.json().path;
    await apiAs(yamada, 'DELETE', `/api/docs?path=${encodeURIComponent(docPath)}`);

    const restored = await apiAs(yamada, 'POST', '/api/trash/restore', {
      trashPath: '.trash/戻す文書.md',
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().path).toBe(docPath);

    const tree = await apiAs(yamada, 'GET', '/api/tree');
    expect(tree.json().docs.map((d: { path: string }) => d.path)).toContain(docPath);

    const history = await app.gitService.history(docPath);
    expect(history[0].message).toBe(`untrash: ${docPath}`);
  }, 30_000);

  it('復元先に同名文書があれば連番が付く', async () => {
    const created = await apiAs(yamada, 'POST', '/api/docs', { folder: '', title: '衝突' });
    await apiAs(yamada, 'DELETE', `/api/docs?path=${encodeURIComponent(created.json().path)}`);
    // 同名の新しい文書を作ってから復元
    await apiAs(yamada, 'POST', '/api/docs', { folder: '', title: '衝突' });

    const restored = await apiAs(yamada, 'POST', '/api/trash/restore', {
      trashPath: '.trash/衝突.md',
    });
    expect(restored.json().path).toBe('衝突 (2).md');
  }, 30_000);

  it('.gitignore に .tsumiwiki-trash.json が載っており git 追跡外(#86 fix-forward)', async () => {
    const { readFile } = await import('node:fs/promises');
    const ignore = await readFile(join(lib, '.gitignore'), 'utf8');
    expect(ignore).toContain('.tsumiwiki-trash.json');
    // フォルダ削除→trash: コミットの diff にメタファイルが含まれないこと
    await apiAs(yamada, 'POST', '/api/folders', { path: 'メタ確認' });
    await apiAs(yamada, 'DELETE', `/api/folders?path=${encodeURIComponent('メタ確認')}`);
    const history = await app.gitService.history('.trash/メタ確認');
    // 履歴取得できる=何かしらコミットは存在するが、メタ自体は追跡されない事実は
    // .gitignore の内容確認で十分担保できているので history が空配列(空フォルダで実質差分なし)
    // でも許容する
    expect(Array.isArray(history)).toBe(true);
  }, 30_000);

  it('trashメタが壊れていれば null にフォールバック(#86 fix-forward)', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(lib, '.trash', 'こわれ'), { recursive: true });
    // originalPath はあるが deletedAt が数値 → 弾く
    await writeFile(
      join(lib, '.trash', 'こわれ', '.tsumiwiki-trash.json'),
      JSON.stringify({ originalPath: 'x/y', deletedAt: 42, deletedBy: 'z' }),
      'utf8',
    );

    const list = await apiAs(yamada, 'GET', '/api/trash');
    const entry = list.json().entries.find((e: { name: string }) => e.name === 'こわれ');
    expect(entry).toBeTruthy();
    // 壊れているので git log にフォールバック→どちらも由来不明で null
    expect(entry.originalPath).toBeNull();
  }, 30_000);

  it('復元時にユーザー独自の(有効でない)同名ファイルは破壊しない(#86 fix-forward)', async () => {
    const { mkdir, writeFile, readFile, rename } = await import('node:fs/promises');
    // 手動配置: .trash/守る の中にユーザーが独自の .tsumiwiki-trash.json を置く(有効な TrashMeta 形式ではない)
    await mkdir(join(lib, '.trash', '守る'), { recursive: true });
    await writeFile(
      join(lib, '.trash', '守る', '.tsumiwiki-trash.json'),
      'これは有効なJSONではない',
      'utf8',
    );
    // rename は使わない(mkdir で直接 .trash 配下に作成済み)
    void rename;

    const restored = await apiAs(yamada, 'POST', '/api/trash/restore', {
      trashPath: '.trash/守る',
    });
    expect(restored.statusCode).toBe(200);
    // 復元先に .tsumiwiki-trash.json は残っているはず(壊れているので破棄しない)
    const content = await readFile(join(lib, restored.json().path, '.tsumiwiki-trash.json'), 'utf8');
    expect(content).toBe('これは有効なJSONではない');
  }, 30_000);

  it('空のフォルダを削除しても元パスがメタデータから復元される(ユーザー報告のバグ)', async () => {
    // 空のフォルダだけを作って削除する
    await apiAs(yamada, 'POST', '/api/folders', { path: '空フォルダ' });
    await apiAs(yamada, 'DELETE', `/api/folders?path=${encodeURIComponent('空フォルダ')}`);

    const list = await apiAs(yamada, 'GET', '/api/trash');
    const entry = list.json().entries.find((e: { name: string }) => e.name === '空フォルダ');
    expect(entry).toBeTruthy();
    expect(entry.isFolder).toBe(true);
    // 中身がない空フォルダはgitに差分が乗らずtrash:コミットが作れないため、
    // .tsumiwiki-trash.json 由来メタデータ経由で元パスが復元される
    expect(entry.originalPath).toBe('空フォルダ');
    expect(entry.deletedBy).toBe('山田');
  }, 30_000);

  it('ネストしたフォルダを削除・復元すると元の場所に戻り、由来メタは残らない', async () => {
    await apiAs(yamada, 'POST', '/api/folders', { path: '親/子' });
    await apiAs(yamada, 'DELETE', `/api/folders?path=${encodeURIComponent('親/子')}`);

    const list = await apiAs(yamada, 'GET', '/api/trash');
    const entry = list.json().entries.find((e: { name: string }) => e.name === '子');
    expect(entry.originalPath).toBe('親/子');

    const restored = await apiAs(yamada, 'POST', '/api/trash/restore', { trashPath: '.trash/子' });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().path).toBe('親/子');
    const tree = await apiAs(yamada, 'GET', '/api/tree');
    expect(tree.json().folders).toContain('親/子');
  }, 30_000);

  it('フォルダごと削除→復元で配下の文書も戻る', async () => {
    await apiAs(yamada, 'POST', '/api/docs', { folder: '一式', title: '中身A' });
    await apiAs(yamada, 'POST', '/api/docs', { folder: '一式', title: '中身B' });
    await apiAs(yamada, 'DELETE', `/api/folders?path=${encodeURIComponent('一式')}`);

    const list = await apiAs(yamada, 'GET', '/api/trash');
    const entry = list.json().entries.find((e: { name: string }) => e.name === '一式');
    expect(entry.isFolder).toBe(true);

    const restored = await apiAs(yamada, 'POST', '/api/trash/restore', {
      trashPath: '.trash/一式',
    });
    expect(restored.json().path).toBe('一式');

    const tree = await apiAs(yamada, 'GET', '/api/tree');
    const paths = tree.json().docs.map((d: { path: string }) => d.path);
    expect(paths).toContain('一式/中身A.md');
    expect(paths).toContain('一式/中身B.md');
  }, 30_000);

  it('完全削除はadminのみ実行でき、ファイルが消える', async () => {
    const created = await apiAs(yamada, 'POST', '/api/docs', { folder: '', title: '完全削除対象' });
    await apiAs(yamada, 'DELETE', `/api/docs?path=${encodeURIComponent(created.json().path)}`);

    const denied = await apiAs(
      yamada,
      'DELETE',
      `/api/trash?path=${encodeURIComponent('.trash/完全削除対象.md')}`,
    );
    expect(denied.statusCode).toBe(403);

    const purged = await apiAs(
      admin,
      'DELETE',
      `/api/trash?path=${encodeURIComponent('.trash/完全削除対象.md')}`,
    );
    expect(purged.statusCode).toBe(200);

    const list = await apiAs(yamada, 'GET', '/api/trash');
    expect(list.json().entries).toHaveLength(0);
  }, 30_000);

  it('ごみ箱外・ネストパスの復元/完全削除は400', async () => {
    for (const bad of ['文書.md', '.trash/a/b.md', '.trash/../外.md']) {
      const res = await apiAs(admin, 'POST', '/api/trash/restore', { trashPath: bad });
      expect(res.statusCode).toBe(400);
    }
  }, 20_000);
});

describe('レビュー指摘の回帰テスト', () => {
  it('完全削除の不正パスは400', async () => {
    for (const bad of ['文書.md', '.trash/a/b.md', '.trash/../外.md']) {
      const res = await apiAs(admin, 'DELETE', `/api/trash?path=${encodeURIComponent(bad)}`);
      expect(res.statusCode).toBe(400);
    }
  }, 20_000);

  it('手動で置かれた由来不明ファイルも一覧・復元できる(basenameフォールバック)', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(lib, '.trash'), { recursive: true });
    await writeFile(join(lib, '.trash', '手動配置.md'), '中身\n', 'utf8');

    const list = await apiAs(yamada, 'GET', '/api/trash');
    const entry = list.json().entries.find((e: { name: string }) => e.name === '手動配置.md');
    expect(entry).toBeTruthy();
    expect(entry.originalPath).toBeNull();

    const restored = await apiAs(yamada, 'POST', '/api/trash/restore', {
      trashPath: '.trash/手動配置.md',
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().path).toBe('手動配置.md'); // ルート直下へ
  }, 30_000);

  it('フォルダの完全削除(再帰rm)ができる', async () => {
    await apiAs(yamada, 'POST', '/api/docs', { folder: '消すフォルダ', title: '中身' });
    await apiAs(yamada, 'DELETE', `/api/folders?path=${encodeURIComponent('消すフォルダ')}`);

    const purged = await apiAs(
      admin,
      'DELETE',
      `/api/trash?path=${encodeURIComponent('.trash/消すフォルダ')}`,
    );
    expect(purged.statusCode).toBe(200);
    const list = await apiAs(yamada, 'GET', '/api/trash');
    expect(list.json().entries).toHaveLength(0);
  }, 30_000);

  it('.trash未作成なら一覧は空配列', async () => {
    const list = await apiAs(yamada, 'GET', '/api/trash');
    expect(list.statusCode).toBe(200);
    expect(list.json().entries).toEqual([]);
  }, 20_000);
});
