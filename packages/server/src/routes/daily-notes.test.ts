import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';

// #84 Phase 2: デイリーノートAPIのテスト

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
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-daily-'));
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

function todayFilename(pattern: string, date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return pattern
    .replace(/YYYY/g, String(date.getFullYear()))
    .replace(/MM/g, p(date.getMonth() + 1))
    .replace(/DD/g, p(date.getDate()));
}

describe('デイリーノートAPI', () => {
  it('デフォルト設定で今日のノートを新規作成する', async () => {
    const res = await apiAs(yamada, 'POST', '/api/daily-notes/today');
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(true);
    expect(res.json().path).toBe(`日記/${todayFilename('YYYY-MM-DD')}.md`);

    // ツリーに反映
    const tree = await apiAs(yamada, 'GET', '/api/tree');
    expect(tree.json().docs.map((d: { path: string }) => d.path)).toContain(res.json().path);
  }, 30_000);

  it('2回叩くと1回目は作成、2回目は既存を返す(created:false)', async () => {
    const first = await apiAs(yamada, 'POST', '/api/daily-notes/today');
    expect(first.json().created).toBe(true);

    const second = await apiAs(yamada, 'POST', '/api/daily-notes/today');
    expect(second.json().created).toBe(false);
    expect(second.json().path).toBe(first.json().path);
  }, 30_000);

  it('テンプレを設定していれば変数展開して作成する', async () => {
    // テンプレを作成
    await apiAs(admin, 'POST', '/api/docs', { folder: '_templates', title: '日誌' });
    const tmplPath = '_templates/日誌.md';
    // テンプレ本文にPUT(ロック取得→保存)
    await apiAs(admin, 'POST', '/api/locks', { path: tmplPath });
    const tmplBody = '---\ndate: {{date}}\n---\n\n# {{title}}\n\n担当: {{user}}\n\n本日の記録:\n';
    const getRes = await apiAs(admin, 'GET', `/api/docs?path=${encodeURIComponent(tmplPath)}`);
    await apiAs(admin, 'PUT', '/api/docs', {
      path: tmplPath,
      body: tmplBody,
      tags: [],
      baseUpdatedAt: getRes.json().updatedAt,
    });

    // ライブラリ設定でテンプレを指定
    await apiAs(admin, 'PUT', '/api/library/settings', {
      templates: { folder: '_templates' },
      dailyNotes: {
        folder: '日記',
        template: tmplPath,
        filenamePattern: 'YYYY-MM-DD',
      },
    });

    // 山田で今日のノート作成
    const res = await apiAs(yamada, 'POST', '/api/daily-notes/today');
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(true);

    // 内容を確認
    const doc = await apiAs(yamada, 'GET', `/api/docs?path=${encodeURIComponent(res.json().path)}`);
    const body = doc.json().body;
    const today = todayFilename('YYYY-MM-DD');
    expect(body).toContain(`# ${today}`);
    expect(body).toContain('担当: 山田');
    expect(body).toContain(`date: ${today}`);
  }, 30_000);

  it('未認証は401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/daily-notes/today',
      headers: CSRF,
    });
    expect(res.statusCode).toBe(401);
  }, 20_000);
});
