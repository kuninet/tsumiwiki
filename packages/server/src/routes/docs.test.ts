import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';

// 文書・フォルダAPIのテスト(FR-DOC / 設計03章)
// 一時ディレクトリに実ライブラリ(Gitリポジトリ)を作って検証する

const CSRF = { 'x-requested-with': 'TsumiWiki' };

type App = ReturnType<typeof buildApp>;
let app: App;
let lib: string;
let cookie: string;

beforeEach(async () => {
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-docs-'));
  const config = loadConfig({ LIBRARY_PATH: lib });
  const db = openDatabase(':memory:');
  app = buildApp({ config, db, logger: false });
  await app.ready(); // git init が走る
  app.userService.create({
    username: 'yamada',
    displayName: '山田 太郎',
    password: 'pass',
    role: 'user',
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: CSRF,
    payload: { username: 'yamada', password: 'pass' },
  });
  cookie = (res.headers['set-cookie'] as string).split(';')[0];
});

afterEach(async () => {
  await app.close();
  await rm(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function api(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { ...CSRF, cookie },
    payload: payload as never,
  });
}

// 保存はロック保持が前提(FR-LOCK)。ロック取得してからPUTするヘルパー
async function saveDoc(payload: { path: string; [k: string]: unknown }) {
  await api('POST', '/api/locks', { path: payload.path });
  return api('PUT', '/api/docs', payload);
}

describe('文書CRUD', () => {
  it('作成→ツリー反映→取得(フロントマター分離)の一連が動作する', async () => {
    const created = await api('POST', '/api/docs', { folder: '議事録', title: '週次ミーティング' });
    expect(created.statusCode).toBe(201);
    expect(created.json().path).toBe('議事録/週次ミーティング.md');

    const tree = await api('GET', '/api/tree');
    expect(tree.json().folders).toContain('議事録');
    expect(tree.json().docs.map((d: { path: string }) => d.path)).toContain(
      '議事録/週次ミーティング.md',
    );

    const doc = await api('GET', '/api/docs?path=' + encodeURIComponent('議事録/週次ミーティング.md'));
    expect(doc.statusCode).toBe(200);
    expect(doc.json().body.trim()).toBe(''); // 本文にフロントマターが混ざらない
    expect(doc.json().frontmatter.created).toBeTruthy();
  }, 20_000);

  it('保存でタグ・本文が更新され、Git履歴にauthorが記録される', async () => {
    const created = await api('POST', '/api/docs', { folder: '', title: 'メモ' });
    const docPath = created.json().path;
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(docPath)}`);

    const saved = await saveDoc({
      path: docPath,
      body: '# メモ\n\n本文です。',
      tags: ['設計', 'メモ'],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(saved.statusCode).toBe(200);

    const after = await api('GET', `/api/docs?path=${encodeURIComponent(docPath)}`);
    expect(after.json().body).toContain('本文です。');
    expect(after.json().tags).toEqual(['設計', 'メモ']);

    const history = await app.gitService.history(docPath);
    expect(history[0].message).toBe(`edit: ${docPath}`);
    expect(history[0].authorName).toBe('山田 太郎');
  }, 20_000);

  it('未知のフロントマターキーを保存後も保全する(FR-OBS-07)', async () => {
    // Obsidianプラグイン由来を想定した未知キー付きファイルを直接作成
    await writeFile(
      join(lib, 'プラグイン文書.md'),
      '---\ntags: [旧タグ]\ncustom_key: 大事な値\n---\n\n本文\n',
      'utf8',
    );
    await app.indexerService.indexFile('プラグイン文書.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('プラグイン文書.md')}`);
    const saved = await saveDoc({
      path: 'プラグイン文書.md',
      body: '更新した本文',
      tags: ['新タグ'],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(saved.statusCode).toBe(200);

    const raw = await readFile(join(lib, 'プラグイン文書.md'), 'utf8');
    expect(raw).toContain('custom_key: 大事な値');
    expect(raw).toContain('新タグ');
    expect(raw).not.toContain('旧タグ');
  }, 20_000);

  it('フロントマターのない文書にタグなし保存してもフロントマターを付けない', async () => {
    await writeFile(join(lib, '素の文書.md'), '素の本文\n', 'utf8');
    await app.indexerService.indexFile('素の文書.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('素の文書.md')}`);
    await saveDoc({
      path: '素の文書.md',
      body: '更新後の本文',
      baseUpdatedAt: got.json().updatedAt,
    });

    const raw = await readFile(join(lib, '素の文書.md'), 'utf8');
    expect(raw).not.toContain('---');
    expect(raw).toContain('更新後の本文');
  }, 20_000);

  it('S1: 保存応答のfrontmatterに未知キーと新しいupdatedが含まれ、コメント行が保全される(#281)', async () => {
    await writeFile(
      join(lib, 'フロントマター保存.md'),
      '---\n# コメント行\nprice: 980\nupdated: 2024-01-01T00:00:00+09:00\n---\n\n本文\n',
      'utf8',
    );
    await app.indexerService.indexFile('フロントマター保存.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('フロントマター保存.md')}`);
    const saved = await saveDoc({
      path: 'フロントマター保存.md',
      body: '新しい本文',
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(saved.statusCode).toBe(200);
    const body = saved.json();
    expect(body.frontmatter).toBeDefined();
    expect(body.frontmatter.price).toBe(980);
    expect(body.frontmatter.updated).not.toBe(got.json().frontmatter.updated);
    expect(Date.parse(body.frontmatter.updated)).toBeGreaterThan(
      Date.parse('2024-01-01T00:00:00+09:00'),
    );

    const raw = await readFile(join(lib, 'フロントマター保存.md'), 'utf8');
    expect(raw).toContain('# コメント行');
  }, 20_000);

  it('S2: フロントマターなし文書の保存応答ではfrontmatterが空オブジェクトになる(#281)', async () => {
    await writeFile(join(lib, 'FMなし.md'), '素の本文\n', 'utf8');
    await app.indexerService.indexFile('FMなし.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('FMなし.md')}`);
    const saved = await saveDoc({
      path: 'FMなし.md',
      body: '更新本文',
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().frontmatter).toEqual({});
  }, 20_000);

  it('S3: 壊れたYAMLフロントマターを持つ文書の保存でもエラーにならずfrontmatterが空オブジェクトになる(#281)', async () => {
    await writeFile(join(lib, '壊れたFM.md'), '---\n: 不正なYAML\n---\n\n本文\n', 'utf8');
    await app.indexerService.indexFile('壊れたFM.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('壊れたFM.md')}`);
    const saved = await saveDoc({
      path: '壊れたFM.md',
      body: '更新本文',
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().frontmatter).toEqual({});
  }, 20_000);

  it('S4: 値の変更でコメントと行順が外科的に保全される(#282)', async () => {
    const src =
      '---\n# コメント\ntitle: 旧 # 行末\nprice: 980\ncreated: 2024-01-15\nupdated: 2024-01-01T00:00:00+09:00\n---\n\n本文\n';
    await writeFile(join(lib, 'S4.md'), src, 'utf8');
    await app.indexerService.indexFile('S4.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('S4.md')}`);
    const saved = await saveDoc({
      path: 'S4.md',
      body: '本文\n',
      frontmatterOps: [{ op: 'set', key: 'title', value: '新' }],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().frontmatter.title).toBe('新');

    const raw = await readFile(join(lib, 'S4.md'), 'utf8');
    const lines = raw.split('\n');
    expect(lines[0]).toBe('---');
    expect(lines[1]).toBe('# コメント');
    expect(lines[2]).toBe('title: 新 # 行末');
    expect(lines[3]).toBe('price: 980');
    expect(lines[4]).toBe('created: 2024-01-15');
    expect(lines[5]).toMatch(/^updated: /);
  }, 20_000);

  it('S5: rename で位置が保持され GET の frontmatter に反映される(#282)', async () => {
    const src =
      '---\n# コメント\ntitle: 旧\nprice: 980\ncreated: 2024-01-15\nupdated: 2024-01-01T00:00:00+09:00\n---\n\n本文\n';
    await writeFile(join(lib, 'S5.md'), src, 'utf8');
    await app.indexerService.indexFile('S5.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('S5.md')}`);
    const saved = await saveDoc({
      path: 'S5.md',
      body: '本文\n',
      frontmatterOps: [{ op: 'rename', from: 'price', to: 'cost' }],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(saved.statusCode).toBe(200);

    const raw = await readFile(join(lib, 'S5.md'), 'utf8');
    expect(raw).toContain('cost: 980');
    expect(raw).not.toContain('price:');
    const titleIdx = raw.indexOf('title: 旧');
    const costIdx = raw.indexOf('cost: 980');
    const createdIdx = raw.indexOf('created: 2024-01-15');
    expect(titleIdx).toBeLessThan(costIdx);
    expect(costIdx).toBeLessThan(createdIdx);

    const after = await api('GET', `/api/docs?path=${encodeURIComponent('S5.md')}`);
    expect(after.json().frontmatter.price).toBeUndefined();
    expect(after.json().frontmatter.cost).toBe(980);
  }, 20_000);

  it('S6: delete でキー行が削除され他が保全される(#282)', async () => {
    const src =
      '---\n# コメント\ntitle: 旧\nprice: 980\ncreated: 2024-01-15\nupdated: 2024-01-01T00:00:00+09:00\n---\n\n本文\n';
    await writeFile(join(lib, 'S6.md'), src, 'utf8');
    await app.indexerService.indexFile('S6.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('S6.md')}`);
    const saved = await saveDoc({
      path: 'S6.md',
      body: '本文\n',
      frontmatterOps: [{ op: 'delete', key: 'price' }],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(saved.statusCode).toBe(200);

    const raw = await readFile(join(lib, 'S6.md'), 'utf8');
    expect(raw).not.toContain('price');
    expect(raw).toContain('# コメント');
    expect(raw).toContain('title: 旧');
    expect(raw).toContain('created: 2024-01-15');
  }, 20_000);

  it('S7: 追加と型の往復(text, number, boolean, date, datetime, list, null)(#282)', async () => {
    const src = '---\ntitle: テスト\nupdated: 2024-01-01T00:00:00+09:00\n---\n\n本文\n';
    await writeFile(join(lib, 'S7.md'), src, 'utf8');
    await app.indexerService.indexFile('S7.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('S7.md')}`);
    const saved = await saveDoc({
      path: 'S7.md',
      body: '本文\n',
      frontmatterOps: [
        { op: 'set', key: 's', value: '123' },
        { op: 'set', key: 'n', value: 1.5 },
        { op: 'set', key: 'b', value: true },
        { op: 'set', key: 'd', value: '2024-02-03' },
        { op: 'set', key: 'dt', value: '2026-10-17T10:00:00+09:00' },
        { op: 'set', key: 'l', value: ['x', 'y'] },
        { op: 'set', key: 'e', value: null },
      ],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(saved.statusCode).toBe(200);

    const after = await api('GET', `/api/docs?path=${encodeURIComponent('S7.md')}`);
    const fm = after.json().frontmatter;
    expect(fm.s).toBe('123');
    expect(typeof fm.s).toBe('string');
    expect(fm.n).toBe(1.5);
    expect(typeof fm.n).toBe('number');
    expect(fm.b).toBe(true);
    expect(typeof fm.b).toBe('boolean');
    expect(fm.d).toBe('2024-02-03T00:00:00.000Z');
    expect(fm.dt).toBe('2026-10-17T01:00:00.000Z');
    expect(fm.l).toEqual(['x', 'y']);
    expect(fm.e).toBeNull();
  }, 20_000);

  it('S8: 未編集の日付が ISO に展開されず原文表記のまま保持される(#282)', async () => {
    const src =
      '---\ntitle: 旧\ncreated: 2024-01-15\nupdated: 2024-01-01T00:00:00+09:00\n---\n\n本文\n';
    await writeFile(join(lib, 'S8.md'), src, 'utf8');
    await app.indexerService.indexFile('S8.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('S8.md')}`);
    const saved = await saveDoc({
      path: 'S8.md',
      body: '本文\n',
      frontmatterOps: [{ op: 'set', key: 'title', value: '新' }],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(saved.statusCode).toBe(200);

    const raw = await readFile(join(lib, 'S8.md'), 'utf8');
    expect(raw).toContain('created: 2024-01-15\n');
    expect(raw).not.toContain('2024-01-15T');
  }, 20_000);

  it('S9: 予約キーへの操作は 400 FRONTMATTER_INVALID でファイル不変(#282)', async () => {
    const src = '---\ntitle: 元\nupdated: 2024-01-01T00:00:00+09:00\n---\n\n本文\n';
    await writeFile(join(lib, 'S9.md'), src, 'utf8');
    await app.indexerService.indexFile('S9.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('S9.md')}`);
    const commitsBefore = (await app.gitService.history('S9.md')).length;

    const saved = await saveDoc({
      path: 'S9.md',
      body: '本文\n',
      frontmatterOps: [{ op: 'set', key: 'updated', value: '2026-10-01' }],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(saved.statusCode).toBe(400);
    expect(saved.json().error.code).toBe('FRONTMATTER_INVALID');

    const raw = await readFile(join(lib, 'S9.md'), 'utf8');
    expect(raw).toBe(src);
    const commitsAfter = (await app.gitService.history('S9.md')).length;
    expect(commitsAfter).toBe(commitsBefore);
  }, 20_000);

  it('S10: 壊れた YAML + ops は 400 FRONTMATTER_INVALID でファイル不変、ops なしは 200(#282)', async () => {
    const src = '---\n: 不正\n---\n\n本文\n';
    await writeFile(join(lib, 'S10.md'), src, 'utf8');
    await app.indexerService.indexFile('S10.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('S10.md')}`);
    const savedFail = await saveDoc({
      path: 'S10.md',
      body: '更新本文\n',
      frontmatterOps: [{ op: 'set', key: 'a', value: 1 }],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(savedFail.statusCode).toBe(400);
    expect(savedFail.json().error.code).toBe('FRONTMATTER_INVALID');

    const raw = await readFile(join(lib, 'S10.md'), 'utf8');
    expect(raw).toBe(src);

    const savedOk = await saveDoc({
      path: 'S10.md',
      body: '更新本文\n',
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(savedOk.statusCode).toBe(200);
  }, 20_000);

  it('S11: フロントマターなし文書にプロパティを追加して保存できる(#282)', async () => {
    const src = '素の本文\n';
    await writeFile(join(lib, 'S11.md'), src, 'utf8');
    await app.indexerService.indexFile('S11.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('S11.md')}`);
    const saved = await saveDoc({
      path: 'S11.md',
      body: '素の本文\n',
      frontmatterOps: [{ op: 'set', key: 'category', value: 'メモ' }],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().frontmatter.category).toBe('メモ');

    const raw = await readFile(join(lib, 'S11.md'), 'utf8');
    expect(raw).toMatch(/^---\ncategory: メモ\nupdated: .*\n---\n\n素の本文\n$/);
  }, 20_000);

  it('S12: 不正な op 形式は 400 VALIDATION_ERROR になる(#282)', async () => {
    const src = '---\ntitle: テスト\n---\n\n本文\n';
    await writeFile(join(lib, 'S12.md'), src, 'utf8');
    await app.indexerService.indexFile('S12.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('S12.md')}`);
    // 入れ子オブジェクトの値
    const res1 = await saveDoc({
      path: 'S12.md',
      body: '本文\n',
      frontmatterOps: [{ op: 'set', key: 'a', value: { x: 1 } }],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(res1.statusCode).toBe(400);
    expect(res1.json().error.code).toBe('VALIDATION_ERROR');

    // 未知の op
    const res2 = await saveDoc({
      path: 'S12.md',
      body: '本文\n',
      frontmatterOps: [{ op: 'move', key: 'a' }],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(res2.statusCode).toBe(400);
    expect(res2.json().error.code).toBe('VALIDATION_ERROR');

    // 文字列 'NaN' は許可される
    const res3 = await saveDoc({
      path: 'S12.md',
      body: '本文\n',
      frontmatterOps: [{ op: 'set', key: 'a', value: 'NaN' }],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(res3.statusCode).toBe(200);
  }, 20_000);

  it('S13: タグ変更とフロントマター操作を同時に保存できる(#282)', async () => {
    const src = '---\ntags: [旧]\nprice: 100\nupdated: 2024-01-01T00:00:00+09:00\n---\n\n本文\n';
    await writeFile(join(lib, 'S13.md'), src, 'utf8');
    await app.indexerService.indexFile('S13.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('S13.md')}`);
    const saved = await saveDoc({
      path: 'S13.md',
      body: '本文\n',
      tags: ['新'],
      frontmatterOps: [{ op: 'set', key: 'a', value: 1 }],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(saved.statusCode).toBe(200);

    const after = await api('GET', `/api/docs?path=${encodeURIComponent('S13.md')}`);
    expect(after.json().tags).toEqual(['新']);
    expect(after.json().frontmatter.a).toBe(1);
    expect(after.json().frontmatter.price).toBe(100);
  }, 20_000);

  it('S14: GET /api/docs で frontmatterStatus (none/ok/invalid) が正しく返る(#282)', async () => {
    await writeFile(join(lib, 'none.md'), '素の本文\n', 'utf8');
    await writeFile(join(lib, 'ok.md'), '---\na: 1\n---\n\n本文\n', 'utf8');
    await writeFile(join(lib, 'invalid.md'), '---\n: 不正\n---\n\n本文\n', 'utf8');
    await app.indexerService.indexFile('none.md');
    await app.indexerService.indexFile('ok.md');
    await app.indexerService.indexFile('invalid.md');

    const resNone = await api('GET', `/api/docs?path=${encodeURIComponent('none.md')}`);
    expect(resNone.statusCode).toBe(200);
    expect(resNone.json().frontmatterStatus).toBe('none');

    const resOk = await api('GET', `/api/docs?path=${encodeURIComponent('ok.md')}`);
    expect(resOk.statusCode).toBe(200);
    expect(resOk.json().frontmatterStatus).toBe('ok');

    const resInvalid = await api('GET', `/api/docs?path=${encodeURIComponent('invalid.md')}`);
    expect(resInvalid.statusCode).toBe(200);
    expect(resInvalid.json().frontmatterStatus).toBe('invalid');
  }, 20_000);

  it('取得後に変更された文書への保存は409(競合検知)', async () => {
    const created = await api('POST', '/api/docs', { folder: '', title: '競合テスト' });
    const docPath = created.json().path;
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(docPath)}`);

    // 1回目の保存(成功)でmtimeが変わる
    await saveDoc({
      path: docPath,
      body: '先に保存',
      baseUpdatedAt: got.json().updatedAt,
    });
    // 古いbaseUpdatedAtでの保存は拒否される
    const conflicted = await saveDoc({
      path: docPath,
      body: '後から保存',
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(conflicted.statusCode).toBe(409);
    expect(conflicted.json().error.code).toBe('CONFLICT');
  }, 20_000);

  it('削除で.trashへ移動し、ツリーから消える', async () => {
    const created = await api('POST', '/api/docs', { folder: '', title: '削除対象' });
    const docPath = created.json().path;

    const deleted = await api('DELETE', `/api/docs?path=${encodeURIComponent(docPath)}`);
    expect(deleted.statusCode).toBe(200);

    const tree = await api('GET', '/api/tree');
    expect(tree.json().docs.map((d: { path: string }) => d.path)).not.toContain(docPath);
    const raw = await readFile(join(lib, '.trash', '削除対象.md'), 'utf8');
    expect(raw).toContain('created');
  }, 20_000);

  it('リネーム後の新パス履歴は「リネーム以降」のみを返す(#66 --follow外し)', async () => {
    const created = await api('POST', '/api/docs', { folder: '', title: '旧タイトル' });
    const docPath = created.json().path;

    const moved = await api('POST', '/api/docs/move', {
      path: docPath,
      newFolder: '新フォルダ',
      newTitle: '新タイトル',
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().path).toBe('新フォルダ/新タイトル.md');

    // --follow を外したためリネーム前の add: は含まれず、move: のみ
    const history = await app.gitService.history('新フォルダ/新タイトル.md');
    expect(history.length).toBe(1);
    expect(history[0].message.startsWith('move:')).toBe(true);
  }, 20_000);

  it('タイトルの禁止文字は全角へ置換される', async () => {
    const created = await api('POST', '/api/docs', { folder: '', title: 'A/B:C?' });
    expect(created.statusCode).toBe(201);
    expect(created.json().path).toBe('A／B：C？.md');
  }, 20_000);

  it('同名タイトルの作成は連番が付く', async () => {
    await api('POST', '/api/docs', { folder: '', title: '重複' });
    const second = await api('POST', '/api/docs', { folder: '', title: '重複' });
    expect(second.json().path).toBe('重複 (2).md');
  }, 20_000);
});

describe('パス検証', () => {
  it('トラバーサル・保護パスへのアクセスは400', async () => {
    for (const bad of ['../outside.md', '.obsidian/app.md', '.git/config.md', '.trash/x.md']) {
      const res = await api('GET', `/api/docs?path=${encodeURIComponent(bad)}`);
      expect([400, 404]).toContain(res.statusCode);
      expect(res.statusCode).toBe(400);
    }
  }, 20_000);
});

describe('フォルダ操作', () => {
  it('作成・移動・削除(ごみ箱へ)が動作する', async () => {
    await api('POST', '/api/folders', { path: '整理前' });
    await api('POST', '/api/docs', { folder: '整理前', title: '中身' });

    const moved = await api('POST', '/api/folders/move', { path: '整理前', newPath: '整理後' });
    expect(moved.statusCode).toBe(200);
    const tree1 = await api('GET', '/api/tree');
    expect(tree1.json().folders).toContain('整理後');
    expect(tree1.json().docs.map((d: { path: string }) => d.path)).toContain('整理後/中身.md');

    const deleted = await api('DELETE', `/api/folders?path=${encodeURIComponent('整理後')}`);
    expect(deleted.statusCode).toBe(200);
    const tree2 = await api('GET', '/api/tree');
    expect(tree2.json().folders).not.toContain('整理後');
    expect(tree2.json().docs).toHaveLength(0);
  }, 30_000);

  it('フォルダを自分自身の配下へは移動できない', async () => {
    await api('POST', '/api/folders', { path: '親' });
    const res = await api('POST', '/api/folders/move', { path: '親', newPath: '親/子' });
    expect(res.statusCode).toBe(400);
  }, 20_000);
});

describe('計画者レビュー反映分', () => {
  it('フロントマターのコメント・未知キーのスタイルが保存後も残る(外科的編集)', async () => {
    await writeFile(
      join(lib, 'スタイル保持.md'),
      '---\ntags: [旧]\n# 大事なコメント\ncustom: {a: 1}\n---\n\n本文\n',
      'utf8',
    );
    await app.indexerService.indexFile('スタイル保持.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('スタイル保持.md')}`);
    await saveDoc({
      path: 'スタイル保持.md',
      body: got.json().body,
      tags: ['新'],
      baseUpdatedAt: got.json().updatedAt,
    });

    const raw = await readFile(join(lib, 'スタイル保持.md'), 'utf8');
    expect(raw).toContain('# 大事なコメント'); // コメント保持
    expect(raw).toMatch(/custom: \{ ?a: 1 ?\}/); // フロースタイル保持(空白差は許容)
    expect(raw).toContain('新');
    expect(raw).not.toContain('旧');
  }, 20_000);

  it('Windows予約デバイス名のタイトルには_が付く', async () => {
    const created = await api('POST', '/api/docs', { folder: '', title: 'CON' });
    expect(created.json().path).toBe('CON_.md');
  }, 20_000);

  it('文書の move レスポンスはサーバー側で正規化された path を返す(sanitizeTitle経由)', async () => {
    // #78 fix-forward: クライアントがraw値でパスを組み立てて 404 になるのを防ぐため、
    // move レスポンスの path は sanitizeTitle 済みの実パスであることを担保する
    const created = await api('POST', '/api/docs', { folder: '', title: 'リネーム元' });
    const moved = await api('POST', '/api/docs/move', {
      path: created.json().path,
      newFolder: '',
      newTitle: 'CON', // sanitize で CON_ になる
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().path).toBe('CON_.md');
  }, 20_000);

  it('フォルダの move レスポンスも正規化された path を返す', async () => {
    await api('POST', '/api/folders', { path: '元フォルダ' });
    const moved = await api('POST', '/api/folders/move', {
      path: '元フォルダ',
      newPath: '新フォルダ',
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().path).toBe('新フォルダ');
  }, 20_000);

  it('移動コミットは無関係な外部変更を巻き込まない(スコープコミット)', async () => {
    const created = await api('POST', '/api/docs', { folder: '', title: '移動対象' });
    // 外部ツールが作った未コミットのファイル
    await writeFile(join(lib, '外部作成.md'), 'AIが直接書いた\n', 'utf8');

    await api('POST', '/api/docs/move', {
      path: created.json().path,
      newFolder: '',
      newTitle: '移動済み',
    });

    // 外部ファイルは未追跡のまま残る(moveコミットに巻き込まれない)
    const { simpleGit } = await import('simple-git');
    const status = await simpleGit({ baseDir: lib }).status();
    expect(status.not_added).toContain('外部作成.md');
  }, 20_000);
});

describe('文書移動時の添付同伴 (#159)', () => {
  // 添付のダミー画像バイト列(4byteでPNG扱いはできないがmoveDoc内容には関与しない)
  const dummyImage = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  async function placeDocWithEmbed(
    folder: string,
    title: string,
    imgFilename: string,
  ): Promise<{ path: string }> {
    await api('POST', '/api/folders', { path: folder });
    await api('POST', '/api/docs', { folder, title });
    const docPath = folder ? `${folder}/${title}.md` : `${title}.md`;
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(docPath)}`);
    // 同フォルダに画像を配置し、本文の embed で参照する
    const imgAbs = folder ? join(lib, folder, imgFilename) : join(lib, imgFilename);
    await writeFile(imgAbs, dummyImage);
    await app.indexerService.indexFile(docPath);
    await saveDoc({
      path: docPath,
      body: `![[${imgFilename}]]\n`,
      tags: [],
      baseUpdatedAt: got.json().updatedAt,
    });
    return { path: docPath };
  }

  async function fileExists(rel: string): Promise<boolean> {
    try {
      await readFile(join(lib, rel));
      return true;
    } catch {
      return false;
    }
  }

  it('専属の画像は文書と一緒に移動先フォルダへ運ばれる', async () => {
    await api('POST', '/api/folders', { path: '移動先' });
    const doc = await placeDocWithEmbed('元', '記事', 'image-A.png');

    const moved = await api('POST', '/api/docs/move', {
      path: doc.path,
      newFolder: '移動先',
      newTitle: '記事',
    });
    expect(moved.statusCode).toBe(200);
    expect(await fileExists('移動先/記事.md')).toBe(true);
    expect(await fileExists('移動先/image-A.png')).toBe(true);
    expect(await fileExists('元/image-A.png')).toBe(false);
  }, 20_000);

  it('専属の画像が移動すると添付索引(attachment_index)も新パスへ追随する(issue #198)', async () => {
    await api('POST', '/api/folders', { path: '移動先2' });
    const doc = await placeDocWithEmbed('元2', '記事2', 'image-C.png');
    // 添付索引に事前登録(通常はaddAttachment経由。ここではファイル直置きのため明示的に索引)
    await app.indexerService.indexAttachment('元2/image-C.png');

    const moved = await api('POST', '/api/docs/move', {
      path: doc.path,
      newFolder: '移動先2',
      newTitle: '記事2',
    });
    expect(moved.statusCode).toBe(200);

    const oldRow = app.db
      .prepare('SELECT rel_path FROM attachment_index WHERE rel_path = ?')
      .get('元2/image-C.png');
    const newRow = app.db
      .prepare('SELECT rel_path FROM attachment_index WHERE rel_path = ?')
      .get('移動先2/image-C.png');
    expect(oldRow).toBeUndefined();
    expect(newRow).toBeDefined();
  }, 20_000);

  it('他文書からも参照されている画像は現地に残る', async () => {
    await api('POST', '/api/folders', { path: '移動先' });
    const doc = await placeDocWithEmbed('元', '本命記事', 'image-B.png');
    // 別 doc が同じファイル名を embed している(実際に image-B.png を参照)
    await api('POST', '/api/folders', { path: '別' });
    await api('POST', '/api/docs', { folder: '別', title: '併用記事' });
    const otherPath = '別/併用記事.md';
    const otherGot = await api('GET', `/api/docs?path=${encodeURIComponent(otherPath)}`);
    await saveDoc({
      path: otherPath,
      body: `![[image-B.png]]\n`,
      tags: [],
      baseUpdatedAt: otherGot.json().updatedAt,
    });

    await api('POST', '/api/docs/move', {
      path: doc.path,
      newFolder: '移動先',
      newTitle: '本命記事',
    });

    // 他文書のリンク維持を優先し、現地に残る(移動先には運ばれない)
    expect(await fileExists('元/image-B.png')).toBe(true);
    expect(await fileExists('移動先/image-B.png')).toBe(false);
  }, 20_000);

  it('タイトル変更のみ(同フォルダ内 rename)では添付を触らない', async () => {
    const doc = await placeDocWithEmbed('固定', '旧タイトル', 'image-C.png');

    await api('POST', '/api/docs/move', {
      path: doc.path,
      newFolder: '固定',
      newTitle: '新タイトル',
    });

    expect(await fileExists('固定/image-C.png')).toBe(true);
    expect(await fileExists('固定/新タイトル.md')).toBe(true);
  }, 20_000);

  it('移動先に同名添付が既にあると誤上書きを避けて現地に残す', async () => {
    await api('POST', '/api/folders', { path: '衝突先' });
    // 移動先に先客の同名画像
    await writeFile(join(lib, '衝突先', 'image-D.png'), Buffer.from([1, 2, 3]));
    const doc = await placeDocWithEmbed('元', '記事', 'image-D.png');

    await api('POST', '/api/docs/move', {
      path: doc.path,
      newFolder: '衝突先',
      newTitle: '記事',
    });

    // 元の画像は残り、移動先の先客画像は保持される
    expect(await fileExists('元/image-D.png')).toBe(true);
    const preserved = await readFile(join(lib, '衝突先', 'image-D.png'));
    expect(Array.from(preserved)).toEqual([1, 2, 3]);
  }, 20_000);

  it('ネスト構造(a/b → x/y)でも専属画像は一緒に移動する', async () => {
    await api('POST', '/api/folders', { path: 'a/b' });
    await api('POST', '/api/folders', { path: 'x/y' });
    const doc = await placeDocWithEmbed('a/b', 'ネスト記事', 'image-nest.png');

    await api('POST', '/api/docs/move', {
      path: doc.path,
      newFolder: 'x/y',
      newTitle: 'ネスト記事',
    });

    expect(await fileExists('x/y/ネスト記事.md')).toBe(true);
    expect(await fileExists('x/y/image-nest.png')).toBe(true);
    expect(await fileExists('a/b/image-nest.png')).toBe(false);
  }, 20_000);

  it('ルート→フォルダ / フォルダ→ルート の双方向で専属画像を運ぶ', async () => {
    // ルート → フォルダ
    const rootDoc = await placeDocWithEmbed('', 'ルート発', 'image-root.png');
    await api('POST', '/api/folders', { path: '受け先' });
    await api('POST', '/api/docs/move', {
      path: rootDoc.path,
      newFolder: '受け先',
      newTitle: 'ルート発',
    });
    expect(await fileExists('受け先/image-root.png')).toBe(true);
    expect(await fileExists('image-root.png')).toBe(false);

    // フォルダ → ルート
    const folderDoc = await placeDocWithEmbed('元フォルダ', 'ルートへ', 'image-back.png');
    await api('POST', '/api/docs/move', {
      path: folderDoc.path,
      newFolder: '',
      newTitle: 'ルートへ',
    });
    expect(await fileExists('image-back.png')).toBe(true);
    expect(await fileExists('元フォルダ/image-back.png')).toBe(false);
  }, 20_000);

  it('複数添付のうち一部だけ他 doc と共有なら、専属のみ運ばれ共有は残る', async () => {
    await api('POST', '/api/folders', { path: '元' });
    await api('POST', '/api/folders', { path: '先' });
    await api('POST', '/api/docs', { folder: '元', title: '複数持ち' });
    const docPath = '元/複数持ち.md';
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(docPath)}`);
    await writeFile(join(lib, '元', 'image-solo.png'), dummyImage);
    await writeFile(join(lib, '元', 'image-shared.png'), dummyImage);
    await app.indexerService.indexFile(docPath);
    await saveDoc({
      path: docPath,
      body: '![[image-solo.png]]\n![[image-shared.png]]\n',
      tags: [],
      baseUpdatedAt: got.json().updatedAt,
    });
    // 別 doc が image-shared.png を参照
    await api('POST', '/api/docs', { folder: '', title: '共有元' });
    const otherGot = await api('GET', `/api/docs?path=${encodeURIComponent('共有元.md')}`);
    await saveDoc({
      path: '共有元.md',
      body: '![[image-shared.png]]\n',
      tags: [],
      baseUpdatedAt: otherGot.json().updatedAt,
    });

    await api('POST', '/api/docs/move', {
      path: docPath,
      newFolder: '先',
      newTitle: '複数持ち',
    });

    // 専属は一緒に、共有は元フォルダに残る
    expect(await fileExists('先/image-solo.png')).toBe(true);
    expect(await fileExists('元/image-solo.png')).toBe(false);
    expect(await fileExists('元/image-shared.png')).toBe(true);
    expect(await fileExists('先/image-shared.png')).toBe(false);
  }, 20_000);

  it('マークダウン画像形式 `![alt](x.png)` でも専属判定して運ぶ', async () => {
    await api('POST', '/api/folders', { path: '元' });
    await api('POST', '/api/folders', { path: '先' });
    await api('POST', '/api/docs', { folder: '元', title: 'MD画像' });
    const docPath = '元/MD画像.md';
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(docPath)}`);
    await writeFile(join(lib, '元', 'image-md.png'), dummyImage);
    await app.indexerService.indexFile(docPath);
    await saveDoc({
      path: docPath,
      body: '![alt文言](image-md.png "タイトル")\n',
      tags: [],
      baseUpdatedAt: got.json().updatedAt,
    });

    await api('POST', '/api/docs/move', {
      path: docPath,
      newFolder: '先',
      newTitle: 'MD画像',
    });

    expect(await fileExists('先/image-md.png')).toBe(true);
    expect(await fileExists('元/image-md.png')).toBe(false);
  }, 20_000);

  it('部分一致(image-1.png と image-11.png の共存)で false-shared 判定にならない', async () => {
    await api('POST', '/api/folders', { path: '元' });
    await api('POST', '/api/folders', { path: '先' });
    // 移動対象 doc が image-1.png を持つ
    await api('POST', '/api/docs', { folder: '元', title: '短名画像' });
    const docPath = '元/短名画像.md';
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(docPath)}`);
    await writeFile(join(lib, '元', 'image-1.png'), dummyImage);
    await app.indexerService.indexFile(docPath);
    await saveDoc({
      path: docPath,
      body: '![[image-1.png]]\n',
      tags: [],
      baseUpdatedAt: got.json().updatedAt,
    });
    // 別 doc は image-11.png を参照(image-1.png ではない)
    await api('POST', '/api/docs', { folder: '', title: '長名画像' });
    const otherGot = await api('GET', `/api/docs?path=${encodeURIComponent('長名画像.md')}`);
    await saveDoc({
      path: '長名画像.md',
      body: '![[image-11.png]]\n',
      tags: [],
      baseUpdatedAt: otherGot.json().updatedAt,
    });

    await api('POST', '/api/docs/move', {
      path: docPath,
      newFolder: '先',
      newTitle: '短名画像',
    });

    // 境界チェックが効いて image-1.png は専属と判定される
    expect(await fileExists('先/image-1.png')).toBe(true);
    expect(await fileExists('元/image-1.png')).toBe(false);
  }, 20_000);
});

describe('レビュー指摘の回帰テスト', () => {
  it('大文字小文字のみのリネームが成功する', async () => {
    const created = await api('POST', '/api/docs', { folder: '', title: 'readme' });
    const moved = await api('POST', '/api/docs/move', {
      path: created.json().path,
      newFolder: '',
      newTitle: 'README',
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().path).toBe('README.md');
  }, 20_000);

  it('移動先に別の文書があると409', async () => {
    await api('POST', '/api/docs', { folder: '', title: '先客' });
    const created = await api('POST', '/api/docs', { folder: '', title: '移動する方' });
    const res = await api('POST', '/api/docs/move', {
      path: created.json().path,
      newFolder: '',
      newTitle: '先客',
    });
    expect(res.statusCode).toBe(409);
  }, 20_000);

  it('CRLF文書を保存するとLFに統一される(NFR-COMP-03)', async () => {
    await writeFile(join(lib, 'CRLF文書.md'), '---\r\ntags: [win]\r\n---\r\n\r\n本文行1\r\n本文行2\r\n', 'utf8');
    await app.indexerService.indexFile('CRLF文書.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('CRLF文書.md')}`);
    const saved = await saveDoc({
      path: 'CRLF文書.md',
      body: got.json().body,
      tags: ['win'],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(saved.statusCode).toBe(200);

    const raw = await readFile(join(lib, 'CRLF文書.md'), 'utf8');
    expect(raw).not.toContain('\r');
    expect(raw).toContain('本文行1');
  }, 20_000);

  it('壊れた(未終端)フロントマターの文書は往復で二重化しない', async () => {
    const broken = '---\ntags: [unclosed\n本文だけが続く\n';
    await writeFile(join(lib, '壊れFM.md'), broken, 'utf8');
    await app.indexerService.indexFile('壊れFM.md');

    const got = await api('GET', `/api/docs?path=${encodeURIComponent('壊れFM.md')}`);
    const saved = await saveDoc({
      path: '壊れFM.md',
      body: got.json().body,
      tags: ['付けたいタグ'],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(saved.statusCode).toBe(200);

    const raw = await readFile(join(lib, '壊れFM.md'), 'utf8');
    // FMフェンスが増えていない(二重化なし)
    expect(raw.match(/^---$/gm)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(raw).toContain('本文だけが続く');
  }, 20_000);

  it('削除は「元パスの削除+.trashへの追加」としてコミットされる', async () => {
    const created = await api('POST', '/api/docs', { folder: '', title: 'コミット確認' });
    await api('DELETE', `/api/docs?path=${encodeURIComponent(created.json().path)}`);

    const { simpleGit } = await import('simple-git');
    const show = await simpleGit({ baseDir: lib }).raw(['show', '--name-status', '--pretty=format:', 'HEAD']);
    expect(show).toContain('.trash/コミット確認.md');
  }, 20_000);

  it('既存ファイルと同名のフォルダ作成は400', async () => {
    const created = await api('POST', '/api/docs', { folder: '', title: 'ファイル先客' });
    const res = await api('POST', '/api/folders', { path: created.json().path });
    expect(res.statusCode).toBe(400);
  }, 20_000);
});

describe('文書側索引反映のbest-effort化 (issue #203)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('保存時に索引更新(indexFile)が失敗しても保存自体は200で成功する', async () => {
    const created = await api('POST', '/api/docs', { folder: '', title: '索引失敗保存' });
    const docPath = created.json().path;
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(docPath)}`);

    vi.spyOn(app.indexerService, 'indexFile').mockRejectedValueOnce(new Error('索引DB書き込み失敗'));

    const saved = await saveDoc({
      path: docPath,
      body: '索引が失敗しても本文は保存される',
      tags: ['タグ'],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(saved.statusCode).toBe(200);

    const raw = await readFile(join(lib, docPath), 'utf8');
    expect(raw).toContain('索引が失敗しても本文は保存される');
  }, 20_000);

  it('移動時に索引更新(moveFile)が失敗してもロック・下書きは新パスへ付け替わる', async () => {
    const created = await api('POST', '/api/docs', { folder: '', title: '索引失敗移動' });
    const docPath = created.json().path;

    // ロック取得+下書き保存(移動後にrepathされることを確認するための準備)
    await api('POST', '/api/locks', { path: docPath });
    await api('PUT', '/api/drafts', { path: docPath, content: '下書き本文' });

    vi.spyOn(app.indexerService, 'moveFile').mockRejectedValueOnce(new Error('索引DB書き込み失敗'));

    const moved = await api('POST', '/api/docs/move', {
      path: docPath,
      newFolder: '移動先',
      newTitle: '索引失敗移動後',
    });
    expect(moved.statusCode).toBe(200);
    const newPath = moved.json().path;
    expect(newPath).toBe('移動先/索引失敗移動後.md');

    // ロックが新パスへ付け替わっている(旧パスはロックなし扱いになる)
    expect(app.lockService.getActive(newPath)).not.toBeNull();
    expect(app.lockService.getActive(docPath)).toBeNull();

    // 下書きも新パスへ付け替わっている
    const draft = await api('GET', `/api/drafts?path=${encodeURIComponent(newPath)}`);
    expect(draft.json().draft?.content).toBe('下書き本文');
  }, 20_000);

  describe('GET /api/docs/backlinks', () => {
    it('未認証アクセスは401を返す', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/docs/backlinks?path=test.md',
        headers: CSRF,
      });
      expect(res.statusCode).toBe(401);
    });

    it('path未指定時は400を返す', async () => {
      const res = await api('GET', '/api/docs/backlinks');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('存在しない文書を指定した場合は404を返す', async () => {
      const res = await api('GET', '/api/docs/backlinks?path=nonexistent.md');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });

    it('正常系: 文書へのバックリンク一覧を返す', async () => {
      const target = await api('POST', '/api/docs', { folder: '', title: 'リンク先' });
      expect(target.statusCode).toBe(201);
      const targetPath = target.json().path;

      const source = await api('POST', '/api/docs', { folder: 'ノート', title: 'リンク元' });
      expect(source.statusCode).toBe(201);
      const sourcePath = source.json().path;

      const gotSource = await api('GET', `/api/docs?path=${encodeURIComponent(sourcePath)}`);
      await saveDoc({
        path: sourcePath,
        body: '[[リンク先]] を参照しています。\n',
        tags: [],
        baseUpdatedAt: gotSource.json().updatedAt,
      });

      const res = await api('GET', `/api/docs/backlinks?path=${encodeURIComponent(targetPath)}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.truncated).toBe(false);
      expect(body.backlinks).toHaveLength(1);
      expect(body.backlinks[0].sourcePath).toBe(sourcePath);
      expect(body.backlinks[0].sourceTitle).toBe('リンク元');
      expect(body.backlinks[0].sourceFolder).toBe('ノート');
      expect(body.backlinks[0].links).toHaveLength(1);
      expect(body.backlinks[0].links[0].context).toContain('リンク先');
    }, 20_000);
  });
});

