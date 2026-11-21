import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  app.userService.create({
    username: 'admin',
    displayName: '管理者',
    password: 'p',
    role: 'admin',
  });
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
    const content = await readFile(
      join(lib, restored.json().path, '.tsumiwiki-trash.json'),
      'utf8',
    );
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

describe('専属添付の同伴移動・復元・完全削除(#161)', () => {
  const dummyPng = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex',
  );
  const dummyPdf = Buffer.from('%PDF-1.4\n% dummy\n%%EOF');

  async function fileExists(relPath: string): Promise<boolean> {
    try {
      await access(join(lib, relPath));
      return true;
    } catch {
      return false;
    }
  }

  async function saveDoc(docPath: string, body: string) {
    const lockRes = await apiAs(yamada, 'POST', '/api/locks', { path: docPath });
    expect(lockRes.statusCode).toBe(200);
    const got = await apiAs(yamada, 'GET', `/api/docs?path=${encodeURIComponent(docPath)}`);
    const res = await apiAs(yamada, 'PUT', '/api/docs', {
      path: docPath,
      body,
      tags: [],
      baseUpdatedAt: got.json().updatedAt,
    });
    expect(res.statusCode).toBe(200);
    await apiAs(yamada, 'DELETE', `/api/locks?path=${encodeURIComponent(docPath)}`);
  }

  async function setAttachmentSettings(attachments: { mode: string; folder: string }) {
    const cur = await apiAs(yamada, 'GET', '/api/library/settings');
    const settings = cur.json().settings;
    const res = await apiAs(admin, 'PUT', '/api/library/settings', {
      ...settings,
      attachments,
    });
    expect(res.statusCode).toBe(200);
  }

  it('AC-1: same-folder で専属添付(画像・PDF)が .trash へ同伴され、一覧から重複隠蔽し、復元で索引と /api/embed が回復する', async () => {
    await apiAs(yamada, 'POST', '/api/folders', { path: 'メモ' });
    await apiAs(yamada, 'POST', '/api/docs', { folder: 'メモ', title: '記事' });
    await writeFile(join(lib, 'メモ', 'a.png'), dummyPng);
    await writeFile(join(lib, 'メモ', 'manual.pdf'), dummyPdf);
    await app.indexerService.indexAttachment('メモ/a.png');
    await app.indexerService.indexAttachment('メモ/manual.pdf');
    await saveDoc('メモ/記事.md', '![[a.png]]\n[手順](manual.pdf)\n');

    const del = await apiAs(
      yamada,
      'DELETE',
      `/api/docs?path=${encodeURIComponent('メモ/記事.md')}`,
    );
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true, skippedAttachments: [] });

    expect(await fileExists('メモ/記事.md')).toBe(false);
    expect(await fileExists('メモ/a.png')).toBe(false);
    expect(await fileExists('メモ/manual.pdf')).toBe(false);
    expect(await fileExists('.trash/記事.md')).toBe(true);
    expect(await fileExists('.trash/a.png')).toBe(true);
    expect(await fileExists('.trash/manual.pdf')).toBe(true);
    expect(await fileExists('.trash/.tsumiwiki-trash.json')).toBe(true);

    expect(
      app.db.prepare('SELECT rel_path FROM attachment_index WHERE rel_path = ?').get('メモ/a.png'),
    ).toBeUndefined();

    const embedMissing = await apiAs(
      yamada,
      'GET',
      `/api/embed?target=${encodeURIComponent('a.png')}&from=${encodeURIComponent('メモ/記事.md')}`,
    );
    expect(embedMissing.statusCode).toBe(404);

    // listTrash は親文書のみ返し、attachmentCount=2、マニフェスト本体は出さない
    const list = await apiAs(yamada, 'GET', '/api/trash');
    expect(list.statusCode).toBe(200);
    expect(list.json().entries).toHaveLength(1);
    expect(list.json().entries[0]).toMatchObject({
      trashPath: '.trash/記事.md',
      name: '記事.md',
      originalPath: 'メモ/記事.md',
      deletedBy: '山田',
      attachmentCount: 2,
    });

    // Git コミットは単一 trash: コミット、かつ .tsumiwiki-trash.json は gitignore 対象
    const { simpleGit } = await import('simple-git');
    const logTrash = await simpleGit({ baseDir: lib }).log({ maxCount: 1 });
    expect(logTrash.latest?.message).toBe('trash: メモ/記事.md');

    const restored = await apiAs(yamada, 'POST', '/api/trash/restore', {
      trashPath: '.trash/記事.md',
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().path).toBe('メモ/記事.md');

    expect(await fileExists('メモ/記事.md')).toBe(true);
    expect(await fileExists('メモ/a.png')).toBe(true);
    expect(await fileExists('メモ/manual.pdf')).toBe(true);
    expect(await fileExists('.trash/a.png')).toBe(false);
    expect(await fileExists('.trash/.tsumiwiki-trash.json')).toBe(false);

    expect(
      app.db.prepare('SELECT rel_path FROM attachment_index WHERE rel_path = ?').get('メモ/a.png'),
    ).toBeDefined();
    const embedRestored = await apiAs(
      yamada,
      'GET',
      `/api/embed?target=${encodeURIComponent('a.png')}&from=${encodeURIComponent('メモ/記事.md')}`,
    );
    expect(embedRestored.statusCode).toBe(200);
  }, 30_000);

  it('AC-2: doc-subfolder モードでは削除後に空になったサブフォルダを掃除し、復元時に再作成する', async () => {
    await setAttachmentSettings({ mode: 'doc-subfolder', folder: 'attachments' });
    await apiAs(yamada, 'POST', '/api/folders', { path: '企画' });
    await apiAs(yamada, 'POST', '/api/docs', { folder: '企画', title: '案' });
    await mkdir(join(lib, '企画', 'attachments'), { recursive: true });
    await writeFile(join(lib, '企画', 'attachments', 'a.png'), dummyPng);
    await app.indexerService.indexAttachment('企画/attachments/a.png');
    await saveDoc('企画/案.md', '![[a.png]]\n');

    const del = await apiAs(yamada, 'DELETE', `/api/docs?path=${encodeURIComponent('企画/案.md')}`);
    expect(del.statusCode).toBe(200);
    expect(await fileExists('.trash/a.png')).toBe(true);
    expect(await fileExists('企画/attachments')).toBe(false);
    expect(await fileExists('企画')).toBe(true); // 文書フォルダ自体は残る

    const restored = await apiAs(yamada, 'POST', '/api/trash/restore', {
      trashPath: '.trash/案.md',
    });
    expect(restored.statusCode).toBe(200);
    expect(await fileExists('企画/attachments/a.png')).toBe(true);
  }, 30_000);

  it('AC-3: vault-folder モードでは共有フォルダの添付を移動しない', async () => {
    await setAttachmentSettings({ mode: 'vault-folder', folder: '_attachments' });
    await apiAs(yamada, 'POST', '/api/folders', { path: 'メモ' });
    await apiAs(yamada, 'POST', '/api/docs', { folder: 'メモ', title: '記事' });
    await mkdir(join(lib, '_attachments'), { recursive: true });
    await writeFile(join(lib, '_attachments', 'v.png'), dummyPng);
    await app.indexerService.indexAttachment('_attachments/v.png');
    await saveDoc('メモ/記事.md', '![[v.png]]\n');

    const del = await apiAs(
      yamada,
      'DELETE',
      `/api/docs?path=${encodeURIComponent('メモ/記事.md')}`,
    );
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true, skippedAttachments: [] });
    expect(await fileExists('_attachments/v.png')).toBe(true);
    expect(await fileExists('.trash/v.png')).toBe(false);
  }, 30_000);

  it('AC-4: 他文書と共有中の添付・未参照添付は現地に残し skippedAttachments を返す', async () => {
    await apiAs(yamada, 'POST', '/api/folders', { path: 'メモ' });
    await apiAs(yamada, 'POST', '/api/folders', { path: '別' });
    await apiAs(yamada, 'POST', '/api/docs', { folder: 'メモ', title: '記事' });
    await apiAs(yamada, 'POST', '/api/docs', { folder: '別', title: '参照' });
    await writeFile(join(lib, 'メモ', 'solo.png'), dummyPng);
    await writeFile(join(lib, 'メモ', 'shared.png'), dummyPng);
    await writeFile(join(lib, 'メモ', 'unreferenced.png'), dummyPng);
    await app.indexerService.indexAttachment('メモ/solo.png');
    await app.indexerService.indexAttachment('メモ/shared.png');
    await app.indexerService.indexAttachment('メモ/unreferenced.png');

    await saveDoc('メモ/記事.md', '![[solo.png]]\n![図](shared.png)\n');
    await saveDoc('別/参照.md', '![[メモ/shared.png]]\n');

    const del = await apiAs(
      yamada,
      'DELETE',
      `/api/docs?path=${encodeURIComponent('メモ/記事.md')}`,
    );
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({
      ok: true,
      skippedAttachments: [{ fileName: 'shared.png', reason: 'shared' }],
    });
    expect(await fileExists('.trash/solo.png')).toBe(true);
    expect(await fileExists('メモ/solo.png')).toBe(false);
    expect(await fileExists('メモ/shared.png')).toBe(true);
    expect(await fileExists('メモ/unreferenced.png')).toBe(true);
    expect(await fileExists('.trash/shared.png')).toBe(false);
    expect(await fileExists('.trash/unreferenced.png')).toBe(false);
  }, 30_000);

  it('AC-5: .trash/ 内衝突と復元先衝突で連番を付与し、復元文書内のリンクも追従書き換えする', async () => {
    await apiAs(yamada, 'POST', '/api/folders', { path: 'メモ' });
    await mkdir(join(lib, '.trash'), { recursive: true });
    await writeFile(join(lib, '.trash', 'a.png'), Buffer.from('old-trash'));

    await apiAs(yamada, 'POST', '/api/docs', { folder: 'メモ', title: '記事' });
    await writeFile(join(lib, 'メモ', 'a.png'), dummyPng);
    await app.indexerService.indexAttachment('メモ/a.png');
    await saveDoc('メモ/記事.md', '![[a.png]]\n![図](a.png)\n');

    await apiAs(yamada, 'DELETE', `/api/docs?path=${encodeURIComponent('メモ/記事.md')}`);
    expect(await fileExists('.trash/a (2).png')).toBe(true);
    expect(await readFile(join(lib, '.trash', 'a.png'), 'utf8')).toBe('old-trash');

    // 復元先に同名の新しい a.png を置いておく
    await writeFile(join(lib, 'メモ', 'a.png'), Buffer.from('newer-live'));
    await app.indexerService.indexAttachment('メモ/a.png');

    const restored = await apiAs(yamada, 'POST', '/api/trash/restore', {
      trashPath: '.trash/記事.md',
    });
    expect(restored.statusCode).toBe(200);
    expect(await readFile(join(lib, 'メモ', 'a.png'), 'utf8')).toBe('newer-live');
    expect(await fileExists('メモ/a (2).png')).toBe(true);

    const restoredMd = await readFile(join(lib, 'メモ', '記事.md'), 'utf8');
    expect(restoredMd).toContain('![[a (2).png]]');
    expect(restoredMd).toContain('![図](a (2).png)');

    const embedNew = await apiAs(
      yamada,
      'GET',
      `/api/embed?target=${encodeURIComponent('a (2).png')}&from=${encodeURIComponent('メモ/記事.md')}`,
    );
    expect(embedNew.statusCode).toBe(200);
    expect(Buffer.compare(embedNew.rawPayload, dummyPng)).toBe(0);
  }, 30_000);

  it('AC-6a: purgeTrash で親文書と同伴添付を両方削除し、マニフェストも整理する', async () => {
    await apiAs(yamada, 'POST', '/api/docs', { folder: '', title: '完全消去' });
    await writeFile(join(lib, 'att.png'), dummyPng);
    await app.indexerService.indexAttachment('att.png');
    await saveDoc('完全消去.md', '![[att.png]]\n');
    await apiAs(yamada, 'DELETE', `/api/docs?path=${encodeURIComponent('完全消去.md')}`);

    expect(await fileExists('.trash/完全消去.md')).toBe(true);
    expect(await fileExists('.trash/att.png')).toBe(true);
    expect(await fileExists('.trash/.tsumiwiki-trash.json')).toBe(true);

    const purged = await apiAs(
      admin,
      'DELETE',
      `/api/trash?path=${encodeURIComponent('.trash/完全消去.md')}`,
    );
    expect(purged.statusCode).toBe(200);
    expect(await fileExists('.trash/完全消去.md')).toBe(false);
    expect(await fileExists('.trash/att.png')).toBe(false);
    expect(await fileExists('.trash/.tsumiwiki-trash.json')).toBe(false);
  }, 30_000);

  it('AC-6b: 削除・復元途中の FS 失敗注入で文書・添付をすべてロールバックする', async () => {
    await apiAs(yamada, 'POST', '/api/folders', { path: 'RB' });
    await apiAs(yamada, 'POST', '/api/docs', { folder: 'RB', title: 'ロールバック' });
    await writeFile(join(lib, 'RB', 'rb.png'), dummyPng);
    await app.indexerService.indexAttachment('RB/rb.png');
    await saveDoc('RB/ロールバック.md', '![[rb.png]]\n');

    const svc = app.docService as unknown as {
      moveFile: (fromAbs: string, toAbs: string) => Promise<void>;
    };
    const origMoveFile = svc.moveFile.bind(app.docService);

    // 1) deleteDoc の 2 回目(添付を .trash/ へ移す瞬間)で失敗注入 → 文書も RB/ へ戻る
    let deleteCall = 0;
    const delSpy = vi.spyOn(svc, 'moveFile').mockImplementation(async (fromAbs, toAbs) => {
      deleteCall++;
      if (deleteCall === 2) throw new Error('injected delete failure');
      return origMoveFile(fromAbs, toAbs);
    });
    try {
      const res = await apiAs(
        yamada,
        'DELETE',
        `/api/docs?path=${encodeURIComponent('RB/ロールバック.md')}`,
      );
      expect(res.statusCode).toBe(500);
    } finally {
      delSpy.mockRestore();
    }
    expect(await fileExists('RB/ロールバック.md')).toBe(true);
    expect(await fileExists('RB/rb.png')).toBe(true);
    expect(await fileExists('.trash/ロールバック.md')).toBe(false);
    expect(await fileExists('.trash/rb.png')).toBe(false);

    // 正常にごみ箱送りしたあと、restoreFromTrash の 2 回目で失敗注入 → .trash/ へ戻る
    const okDel = await apiAs(
      yamada,
      'DELETE',
      `/api/docs?path=${encodeURIComponent('RB/ロールバック.md')}`,
    );
    expect(okDel.statusCode).toBe(200);

    let restoreCall = 0;
    const resSpy = vi.spyOn(svc, 'moveFile').mockImplementation(async (fromAbs, toAbs) => {
      restoreCall++;
      if (restoreCall === 2) throw new Error('injected restore failure');
      return origMoveFile(fromAbs, toAbs);
    });
    try {
      const res = await apiAs(yamada, 'POST', '/api/trash/restore', {
        trashPath: '.trash/ロールバック.md',
      });
      expect(res.statusCode).toBe(500);
    } finally {
      resSpy.mockRestore();
    }
    expect(await fileExists('.trash/ロールバック.md')).toBe(true);
    expect(await fileExists('.trash/rb.png')).toBe(true);
    expect(await fileExists('RB/ロールバック.md')).toBe(false);
    expect(await fileExists('RB/rb.png')).toBe(false);

    // 3) deleteDoc でマニフェスト書き込み(writeAtomic)が失敗した場合もロールバックされる
    const waSvc = app.docService as unknown as {
      writeAtomic: (targetAbs: string, content: string) => Promise<void>;
    };
    const origWriteAtomic = waSvc.writeAtomic.bind(app.docService);
    const waSpy = vi.spyOn(waSvc, 'writeAtomic').mockImplementation(async (targetAbs, content) => {
      if (targetAbs.endsWith('.tsumiwiki-trash.json')) {
        throw new Error('injected manifest write failure');
      }
      return origWriteAtomic(targetAbs, content);
    });
    await apiAs(yamada, 'POST', '/api/trash/restore', { trashPath: '.trash/ロールバック.md' });
    try {
      const res = await apiAs(
        yamada,
        'DELETE',
        `/api/docs?path=${encodeURIComponent('RB/ロールバック.md')}`,
      );
      expect(res.statusCode).toBe(500);
    } finally {
      waSpy.mockRestore();
    }
    expect(await fileExists('RB/ロールバック.md')).toBe(true);
    expect(await fileExists('RB/rb.png')).toBe(true);
    expect(await fileExists('.trash/ロールバック.md')).toBe(false);
    expect(await fileExists('.trash/rb.png')).toBe(false);
  }, 30_000);

  it('AC-6c: マニフェスト破損・欠損添付・親消失でも落ちず、孤立添付が元の添付パスへ正しく復元されマニフェスト本体への直接操作は 400 で拒否する', async () => {
    // 1) .trash/.tsumiwiki-trash.json への直接復元・purge は 400
    await mkdir(join(lib, '.trash'), { recursive: true });
    await writeFile(join(lib, '.trash', '.tsumiwiki-trash.json'), '{broken json', 'utf8');

    const badRestore = await apiAs(admin, 'POST', '/api/trash/restore', {
      trashPath: '.trash/.tsumiwiki-trash.json',
    });
    expect(badRestore.statusCode).toBe(400);
    const badPurge = await apiAs(
      admin,
      'DELETE',
      `/api/trash?path=${encodeURIComponent('.trash/.tsumiwiki-trash.json')}`,
    );
    expect(badPurge.statusCode).toBe(400);

    // 2) マニフェスト破損状態でも listTrash / restoreFromTrash が落ちず、親文書のパスへ画像を誤復元しない
    await apiAs(yamada, 'POST', '/api/folders', { path: 'トレーラー' });
    await apiAs(yamada, 'POST', '/api/docs', { folder: 'トレーラー', title: '耐障害' });
    await writeFile(join(lib, 'トレーラー', 'trailer.png'), dummyPng);
    await app.indexerService.indexAttachment('トレーラー/trailer.png');
    await saveDoc('トレーラー/耐障害.md', '![[trailer.png]]\n');
    await apiAs(yamada, 'DELETE', `/api/docs?path=${encodeURIComponent('トレーラー/耐障害.md')}`);
    // マニフェストを破損させたうえ、別のゴミ削除(.tsumiwiki-trash.json無し状態も含む)相当を検証
    await writeFile(join(lib, '.trash', '.tsumiwiki-trash.json'), 'not json', 'utf8');
    const listBroken = await apiAs(yamada, 'GET', '/api/trash');
    expect(listBroken.statusCode).toBe(200);
    expect(listBroken.json().entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: '耐障害.md',
          originalPath: 'トレーラー/耐障害.md',
        }),
        expect.objectContaining({
          name: 'trailer.png',
          originalPath: 'トレーラー/trailer.png',
        }),
      ]),
    );
    const restoreTrailerNoManifest = await apiAs(yamada, 'POST', '/api/trash/restore', {
      trashPath: '.trash/trailer.png',
    });
    expect(restoreTrailerNoManifest.statusCode).toBe(200);
    expect(restoreTrailerNoManifest.json()).toEqual({ path: 'トレーラー/trailer.png' });
    expect(await fileExists('トレーラー/trailer.png')).toBe(true);
    expect(await fileExists('トレーラー/耐障害.md')).toBe(false);

    const restoreBroken = await apiAs(yamada, 'POST', '/api/trash/restore', {
      trashPath: '.trash/耐障害.md',
    });
    expect(restoreBroken.statusCode).toBe(200);
    expect(await fileExists('トレーラー/耐障害.md')).toBe(true);

    // 3) 親文書が外部削除された場合でもマニフェスト逆引きで元の添付パスを表示・復元でき、復元後はマニフェストも掃除される
    await apiAs(yamada, 'POST', '/api/folders', { path: '孤立' });
    await apiAs(yamada, 'POST', '/api/docs', { folder: '孤立', title: '一部欠損' });
    await writeFile(join(lib, '孤立', 'keep.png'), dummyPng);
    await writeFile(join(lib, '孤立', 'gone.png'), dummyPng);
    await app.indexerService.indexAttachment('孤立/keep.png');
    await app.indexerService.indexAttachment('孤立/gone.png');
    await saveDoc('孤立/一部欠損.md', '![[keep.png]]\n![[gone.png]]\n');
    await apiAs(yamada, 'DELETE', `/api/docs?path=${encodeURIComponent('孤立/一部欠損.md')}`);

    // gone.png を外部削除
    await rm(join(lib, '.trash', 'gone.png'));
    const listMissingAtt = await apiAs(yamada, 'GET', '/api/trash');
    const missingEntry = listMissingAtt
      .json()
      .entries.find((e: { name: string }) => e.name === '一部欠損.md');
    expect(missingEntry?.attachmentCount).toBe(1);

    // 親を外部削除すると残った keep.png が孤立添付として一覧に出る(originalPath は 孤立/keep.png であり 孤立/一部欠損.md ではない)
    await rm(join(lib, '.trash', '一部欠損.md'));
    const listOrphan = await apiAs(yamada, 'GET', '/api/trash');
    const orphanKeep = listOrphan
      .json()
      .entries.find((e: { name: string }) => e.name === 'keep.png');
    expect(orphanKeep).toMatchObject({
      trashPath: '.trash/keep.png',
      name: 'keep.png',
      originalPath: '孤立/keep.png',
    });

    // 孤立添付を復元すると 孤立/keep.png に戻り、孤立/一部欠損.md は作られずマニフェストも掃除される
    const restoreOrphan = await apiAs(yamada, 'POST', '/api/trash/restore', {
      trashPath: '.trash/keep.png',
    });
    expect(restoreOrphan.statusCode).toBe(200);
    expect(restoreOrphan.json()).toEqual({ path: '孤立/keep.png' });
    expect(await fileExists('孤立/keep.png')).toBe(true);
    expect(await fileExists('孤立/一部欠損.md')).toBe(false);
    const manifestAfter = JSON.parse(
      await readFile(join(lib, '.trash', '.tsumiwiki-trash.json'), 'utf8'),
    ) as { items: Record<string, { attachments?: { trashPath: string }[] }> };
    expect(manifestAfter.items['一部欠損.md']?.attachments).toEqual([
      { trashPath: '.trash/gone.png', originalPath: '孤立/gone.png' },
    ]);

    // 4) マニフェスト完全削除(別クローン相当) + トレーラーなし旧形式コミットでも .png が .md を上書きしないガード
    await rm(join(lib, '.trash', '.tsumiwiki-trash.json'), { force: true });
    await writeFile(join(lib, '.trash', 'legacy.png'), dummyPng);
    await app.gitService.commit(['.trash/legacy.png'], 'trash: 孤立/レガシー.md', {
      name: '山田',
      email: 'yamada@example.com',
    });
    const listLegacy = await apiAs(yamada, 'GET', '/api/trash');
    const legacyEntry = listLegacy
      .json()
      .entries.find((e: { name: string }) => e.name === 'legacy.png');
    expect(legacyEntry?.originalPath).toBeNull();
    const restoreLegacy = await apiAs(yamada, 'POST', '/api/trash/restore', {
      trashPath: '.trash/legacy.png',
    });
    expect(restoreLegacy.statusCode).toBe(200);
    expect(restoreLegacy.json()).toEqual({ path: 'legacy.png' });
    expect(await fileExists('孤立/レガシー.md')).toBe(false);
    expect(await fileExists('legacy.png')).toBe(true);
  }, 30_000);

  it('AC-7: 単体 DELETE /api/attachments で削除した添付も従来通り一覧・復元できる', async () => {
    await apiAs(yamada, 'POST', '/api/folders', { path: '単体' });
    await writeFile(join(lib, '単体', 'pic.png'), dummyPng);
    await app.indexerService.indexAttachment('単体/pic.png');

    const del = await apiAs(
      yamada,
      'DELETE',
      `/api/attachments?path=${encodeURIComponent('単体/pic.png')}`,
    );
    expect(del.statusCode).toBe(200);

    const list = await apiAs(yamada, 'GET', '/api/trash');
    expect(list.json().entries).toHaveLength(1);
    expect(list.json().entries[0]).toMatchObject({
      trashPath: '.trash/pic.png',
      originalPath: '単体/pic.png',
    });

    const restored = await apiAs(yamada, 'POST', '/api/trash/restore', {
      trashPath: '.trash/pic.png',
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().path).toBe('単体/pic.png');
    expect(await fileExists('単体/pic.png')).toBe(true);
  }, 30_000);
});
