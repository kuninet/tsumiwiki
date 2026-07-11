import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
