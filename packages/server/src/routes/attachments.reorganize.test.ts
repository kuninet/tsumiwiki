import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIBRARY_SETTINGS_DEFAULTS, type LibrarySettings } from '@tsumiwiki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';

const CSRF = { 'x-requested-with': 'TsumiWiki' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const SEED_AUTHOR = { name: 'Seed', email: 'seed@tsumiwiki.local' };

type App = ReturnType<typeof buildApp>;
let app: App;
let lib: string;
let adminCookie: string;
let userCookie: string;

async function loginAs(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: CSRF,
    payload: { username, password },
  });
  return (res.headers['set-cookie'] as string).split(';')[0];
}

async function setAttachmentSettings(attachments: LibrarySettings['attachments']) {
  const body: LibrarySettings = {
    templates: { ...LIBRARY_SETTINGS_DEFAULTS.templates },
    dailyNotes: { ...LIBRARY_SETTINGS_DEFAULTS.dailyNotes },
    attachments,
  };
  const res = await app.inject({
    method: 'PUT',
    url: '/api/library/settings',
    headers: { ...CSRF, cookie: adminCookie },
    payload: body,
  });
  expect(res.statusCode).toBe(200);
}

async function seedFiles(files: Record<string, string | Buffer>) {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(lib, relPath);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
  await app.gitService.commitAll('seed test library', SEED_AUTHOR);
  await app.indexerService.scanAll();
}

beforeEach(async () => {
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-reorg-'));
  const config = loadConfig({ LIBRARY_PATH: lib });
  const db = openDatabase(':memory:');
  app = buildApp({ config, db, logger: false });
  await app.ready();
  app.userService.create({
    username: 'admin',
    displayName: '管理者',
    password: 'p',
    role: 'admin',
  });
  app.userService.create({
    username: 'yamada',
    displayName: '山田',
    password: 'p',
    role: 'user',
  });
  adminCookie = await loginAs('admin', 'p');
  userCookie = await loginAs('yamada', 'p');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await rm(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('POST /api/attachments/reorganize(/preview)', () => {
  it('vault-folder: 全添付を集約して 1 コミットにまとめ、/api/embed と /api/tree が即座に最新化する', async () => {
    await seedFiles({
      '企画/メモ.md': '# メモ\n![[photo.png]]\n',
      '企画/photo.png': PNG,
      'loose.pdf': PDF,
      'media/stay.png': PNG,
    });
    await setAttachmentSettings({ mode: 'vault-folder', folder: 'media' });

    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/attachments/reorganize/preview',
      headers: { ...CSRF, cookie: adminCookie },
      payload: {},
    });
    expect(previewRes.statusCode).toBe(200);
    const preview = previewRes.json();
    expect(preview.summary).toEqual({
      totalAttachments: 3,
      moveCount: 2,
      renameCount: 0,
      rewriteDocCount: 0,
      skipAlreadyInPlace: 1,
      skipShared: 0,
      skipUnreferenced: 0,
      skipTemplate: 0,
    });

    const historyBefore = (await app.gitService.historyAll(50)).length;
    const execRes = await app.inject({
      method: 'POST',
      url: '/api/attachments/reorganize',
      headers: { ...CSRF, cookie: adminCookie },
      payload: {},
    });
    expect(execRes.statusCode).toBe(200);
    const executed = execRes.json();
    expect(executed.moved).toHaveLength(2);
    expect(executed.rewrittenDocs).toEqual([]);
    expect(executed.skippedCount).toBe(1);

    // Git コミットが 1 件だけ積まれる
    const historyAfter = await app.gitService.historyAll(50);
    expect(historyAfter.length).toBe(historyBefore + 1);
    expect(historyAfter[0].message).toContain('reorganize attachments:');

    // 実ファイル配置とインデックスの即時反映
    expect(existsSync(join(lib, 'media/photo.png'))).toBe(true);
    expect(existsSync(join(lib, 'media/loose.pdf'))).toBe(true);
    expect(existsSync(join(lib, '企画/photo.png'))).toBe(false);

    const embedRes = await app.inject({
      method: 'GET',
      url: `/api/embed?target=photo.png&from=${encodeURIComponent('企画/メモ.md')}`,
      headers: { cookie: userCookie },
    });
    expect(embedRes.statusCode).toBe(200);

    const treeRes = await app.inject({
      method: 'GET',
      url: '/api/tree',
      headers: { cookie: userCookie },
    });
    const attPaths = (treeRes.json().attachments as { path: string }[]).map((a) => a.path);
    expect(attPaths).toContain('media/photo.png');
    expect(attPaths).toContain('media/loose.pdf');
    expect(attPaths).not.toContain('企画/photo.png');
  });

  it('同名衝突時に連番リネームし、該当側文書のリンクだけを書き換える', async () => {
    await seedFiles({
      'a/doc.md': 'A: ![[fig.png]]\n',
      'a/fig.png': PNG,
      'b/doc.md': 'B: ![[fig.png#w=200|図B]]\n',
      'b/fig.png': PNG,
    });
    await setAttachmentSettings({ mode: 'vault-folder', folder: 'assets' });

    const execRes = await app.inject({
      method: 'POST',
      url: '/api/attachments/reorganize',
      headers: { ...CSRF, cookie: adminCookie },
      payload: {},
    });
    expect(execRes.statusCode).toBe(200);
    const body = execRes.json();
    expect(body.moved.map((m: { toPath: string }) => m.toPath)).toEqual([
      'assets/fig.png',
      'assets/fig-2.png',
    ]);
    expect(body.rewrittenDocs.map((d: { path: string }) => d.path)).toEqual(['b/doc.md']);

    expect(await readFile(join(lib, 'a/doc.md'), 'utf8')).toBe('A: ![[fig.png]]\n');
    expect(await readFile(join(lib, 'b/doc.md'), 'utf8')).toBe('B: ![[fig-2.png#w=200|図B]]\n');
  });

  it('doc-subfolder: 専属のみ移動→共通退避オプションで共有ファイルも共通フォルダへ移動する', async () => {
    await seedFiles({
      'a/note.md': '![[a-only.png]]\n![[shared.png]]\n',
      'b/note.md': '![[shared.png]]\n',
      'a-only.png': PNG,
      'shared.png': PNG,
      'unused.png': PNG,
    });
    await setAttachmentSettings({ mode: 'doc-subfolder', folder: 'attachments' });

    const resFalse = await app.inject({
      method: 'POST',
      url: '/api/attachments/reorganize',
      headers: { ...CSRF, cookie: adminCookie },
      payload: { moveSharedToCommonFolder: false },
    });
    expect(resFalse.statusCode).toBe(200);
    expect(existsSync(join(lib, 'a/attachments/a-only.png'))).toBe(true);
    expect(existsSync(join(lib, 'shared.png'))).toBe(true);
    expect(existsSync(join(lib, 'unused.png'))).toBe(true);

    const resTrue = await app.inject({
      method: 'POST',
      url: '/api/attachments/reorganize',
      headers: { ...CSRF, cookie: adminCookie },
      payload: { moveSharedToCommonFolder: true },
    });
    expect(resTrue.statusCode).toBe(200);
    expect(existsSync(join(lib, 'attachments/shared.png'))).toBe(true);
    expect(existsSync(join(lib, 'shared.png'))).toBe(false);
    expect(existsSync(join(lib, 'unused.png'))).toBe(true);
  });

  it('標準 Markdown 相対リンクとパス付き wikilink を書き換え、文書が開ける状態を保つ', async () => {
    await seedFiles({
      'docs/note.md': '![図](sub/pic.png)\n[仕様](../files/spec.pdf)\n![[sub/pic.png]]\n',
      'docs/sub/pic.png': PNG,
      'files/spec.pdf': PDF,
    });
    await setAttachmentSettings({ mode: 'vault-folder', folder: 'media' });

    const execRes = await app.inject({
      method: 'POST',
      url: '/api/attachments/reorganize',
      headers: { ...CSRF, cookie: adminCookie },
      payload: {},
    });
    expect(execRes.statusCode).toBe(200);

    const content = await readFile(join(lib, 'docs/note.md'), 'utf8');
    expect(content).toBe('![図](../media/pic.png)\n[仕様](../media/spec.pdf)\n![[pic.png]]\n');
  });

  it('書き換え対象文書が他ユーザーにロックされていると preview に警告が出て execute は 409 DOC_LOCKED で中断する', async () => {
    await seedFiles({
      'docs/note.md': '![](sub/pic.png)\n',
      'docs/sub/pic.png': PNG,
    });
    await setAttachmentSettings({ mode: 'vault-folder', folder: 'media' });

    const lockRes = await app.inject({
      method: 'POST',
      url: '/api/locks',
      headers: { ...CSRF, cookie: userCookie },
      payload: { path: 'docs/note.md' },
    });
    expect(lockRes.statusCode).toBe(200);

    const prevRes = await app.inject({
      method: 'POST',
      url: '/api/attachments/reorganize/preview',
      headers: { ...CSRF, cookie: adminCookie },
      payload: {},
    });
    expect(prevRes.statusCode).toBe(200);
    expect(prevRes.json().lockedWarnings).toEqual([
      { docPath: 'docs/note.md', displayName: '山田' },
    ]);

    const execRes = await app.inject({
      method: 'POST',
      url: '/api/attachments/reorganize',
      headers: { ...CSRF, cookie: adminCookie },
      payload: {},
    });
    expect(execRes.statusCode).toBe(409);
    expect(execRes.json().error.code).toBe('DOC_LOCKED');

    // ファイルや文書は一切変更されていない
    expect(existsSync(join(lib, 'docs/sub/pic.png'))).toBe(true);
    expect(existsSync(join(lib, 'media/pic.png'))).toBe(false);
    expect(await readFile(join(lib, 'docs/note.md'), 'utf8')).toBe('![](sub/pic.png)\n');
  });

  it('実行途中で FS エラーが起きても移動済みファイルと書き換え済み文書がすべてロールバックされる', async () => {
    await seedFiles({
      'docs/note.md': '![](sub/a.png)\n![](sub/b.png)\n',
      'docs/sub/a.png': PNG,
      'docs/sub/b.png': PNG,
    });
    await setAttachmentSettings({ mode: 'vault-folder', folder: 'media' });
    const historyBefore = (await app.gitService.historyAll(50)).length;

    const svc = app.docService as unknown as {
      moveFile: (fromAbs: string, toAbs: string) => Promise<void>;
    };
    const origMoveFile = svc.moveFile.bind(app.docService);
    let callCount = 0;
    // Phase 1 で 2 件退避したあと、Phase 2 の 2 件目移動時に失敗させる
    vi.spyOn(svc, 'moveFile').mockImplementation(async (fromAbs, toAbs) => {
      callCount++;
      if (callCount === 4) {
        throw new Error('injected FS failure');
      }
      return origMoveFile(fromAbs, toAbs);
    });

    const execRes = await app.inject({
      method: 'POST',
      url: '/api/attachments/reorganize',
      headers: { ...CSRF, cookie: adminCookie },
      payload: {},
    });
    expect(execRes.statusCode).toBe(500);

    // すべて元の位置へ復元され、一時ファイルや中途半端な移動先が残らない
    expect(existsSync(join(lib, 'docs/sub/a.png'))).toBe(true);
    expect(existsSync(join(lib, 'docs/sub/b.png'))).toBe(true);
    expect(existsSync(join(lib, 'media/a.png'))).toBe(false);
    expect(existsSync(join(lib, 'media/b.png'))).toBe(false);
    const subEntries = await readdir(join(lib, 'docs/sub'));
    expect(subEntries.filter((n) => n.startsWith('.tsumiwiki-tmp-'))).toEqual([]);
    expect(await readFile(join(lib, 'docs/note.md'), 'utf8')).toBe(
      '![](sub/a.png)\n![](sub/b.png)\n',
    );
    expect((await app.gitService.historyAll(50)).length).toBe(historyBefore);
  });

  it('一般ユーザーからの呼び出しは 403 FORBIDDEN で拒否される', async () => {
    const prevRes = await app.inject({
      method: 'POST',
      url: '/api/attachments/reorganize/preview',
      headers: { ...CSRF, cookie: userCookie },
      payload: {},
    });
    expect(prevRes.statusCode).toBe(403);

    const execRes = await app.inject({
      method: 'POST',
      url: '/api/attachments/reorganize',
      headers: { ...CSRF, cookie: userCookie },
      payload: {},
    });
    expect(execRes.statusCode).toBe(403);
  });

  it('settings.yaml が壊れているときは 400 INVALID_PATH で拒否しファイルを変更しない', async () => {
    await seedFiles({
      'note.md': '![[a.png]]\n',
      'a.png': PNG,
      '.tsumiwiki/settings.yaml': 'attachments:\n  mode: invalid-mode\n',
    });

    const prevRes = await app.inject({
      method: 'POST',
      url: '/api/attachments/reorganize/preview',
      headers: { ...CSRF, cookie: adminCookie },
      payload: {},
    });
    expect(prevRes.statusCode).toBe(400);
    expect(prevRes.json().error.code).toBe('INVALID_PATH');

    const execRes = await app.inject({
      method: 'POST',
      url: '/api/attachments/reorganize',
      headers: { ...CSRF, cookie: adminCookie },
      payload: {},
    });
    expect(execRes.statusCode).toBe(400);
    expect(existsSync(join(lib, 'a.png'))).toBe(true);
  });

  it('既定 same-folder でもテンプレート文書とテンプレート添付を安全にスキップして整理できる', async () => {
    await seedFiles({
      '_templates/日誌.md': '![[logo.png]]\n![[loose/tpl.png]]\n',
      '_templates/logo.png': PNG,
      'loose/tpl.png': PNG,
      'notes/a.md': '![[old/pic.png]]\n',
      'old/pic.png': PNG,
    });

    const prevRes = await app.inject({
      method: 'POST',
      url: '/api/attachments/reorganize/preview',
      headers: { ...CSRF, cookie: adminCookie },
      payload: {},
    });
    expect(prevRes.statusCode).toBe(200);
    expect(prevRes.json().summary.skipTemplate).toBe(2);
    expect(prevRes.json().moves.map((m: { toPath: string }) => m.toPath)).toEqual([
      'notes/pic.png',
    ]);

    const execRes = await app.inject({
      method: 'POST',
      url: '/api/attachments/reorganize',
      headers: { ...CSRF, cookie: adminCookie },
      payload: {},
    });
    expect(execRes.statusCode).toBe(200);
    expect(existsSync(join(lib, 'notes/pic.png'))).toBe(true);
    expect(existsSync(join(lib, '_templates/logo.png'))).toBe(true);
    expect(existsSync(join(lib, 'loose/tpl.png'))).toBe(true);
  });

  it('Phase 3 書き込み直前に他者が文書を保存していたら 409 CONFLICT で全変更をロールバックし並行保存を守る', async () => {
    await seedFiles({
      'docs/a.md': '![](sub/a.png)\n',
      'docs/b.md': '![](sub/b.png)\n',
      'docs/sub/a.png': PNG,
      'docs/sub/b.png': PNG,
    });
    await setAttachmentSettings({ mode: 'vault-folder', folder: 'media' });

    const svc = app.docService as unknown as {
      moveFile: (fromAbs: string, toAbs: string) => Promise<void>;
    };
    const origMoveFile = svc.moveFile.bind(app.docService);
    let moveCount = 0;
    // Phase 1 (2回) + Phase 2 (2回) の最後の移動直後に docs/b.md を外部更新する
    vi.spyOn(svc, 'moveFile').mockImplementation(async (fromAbs, toAbs) => {
      await origMoveFile(fromAbs, toAbs);
      moveCount++;
      if (moveCount === 4) {
        await writeFile(join(lib, 'docs/b.md'), '![](sub/b.png)\n\n並行追記された行\n');
      }
    });

    const execRes = await app.inject({
      method: 'POST',
      url: '/api/attachments/reorganize',
      headers: { ...CSRF, cookie: adminCookie },
      payload: {},
    });
    expect(execRes.statusCode).toBe(409);
    expect(execRes.json().error.code).toBe('CONFLICT');

    // 先に書き換えられた docs/a.md と移動済み添付はロールバックされ、docs/b.md の並行追記は消えない
    expect(await readFile(join(lib, 'docs/a.md'), 'utf8')).toBe('![](sub/a.png)\n');
    expect(await readFile(join(lib, 'docs/b.md'), 'utf8')).toBe(
      '![](sub/b.png)\n\n並行追記された行\n',
    );
    expect(existsSync(join(lib, 'docs/sub/a.png'))).toBe(true);
    expect(existsSync(join(lib, 'docs/sub/b.png'))).toBe(true);
    expect(existsSync(join(lib, 'media/a.png'))).toBe(false);
    expect(existsSync(join(lib, 'media/b.png'))).toBe(false);
  });
});
