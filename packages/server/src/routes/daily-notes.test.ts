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

  it('2ユーザーが同時に押しても両方200が返り、pathが一致する(レース)', async () => {
    const [a, b] = await Promise.all([
      apiAs(yamada, 'POST', '/api/daily-notes/today'),
      apiAs(admin, 'POST', '/api/daily-notes/today'),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().path).toBe(b.json().path);
    // 片方が created:true、もう片方が false のはず(両方 true / 両方 false にはならない)
    const createdFlags = [a.json().created, b.json().created];
    expect(createdFlags.sort()).toEqual([false, true]);
  }, 30_000);

  it('サブフォルダを含むファイル名パターンで階層に日誌を作れる', async () => {
    await apiAs(admin, 'PUT', '/api/library/settings', {
      templates: { folder: '_templates' },
      dailyNotes: { folder: '日記', template: '', filenamePattern: 'YYYY/MM/DD' },
    });
    const res = await apiAs(yamada, 'POST', '/api/daily-notes/today');
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe(`日記/${todayFilename('YYYY/MM/DD')}.md`);
  }, 30_000);

  it('ライブラリ設定に不正なファイル名パターンは400で拒否される', async () => {
    for (const bad of ['', '.', '..', '{{date}}', 'YYYY:MM']) {
      const res = await apiAs(admin, 'PUT', '/api/library/settings', {
        templates: { folder: '_templates' },
        dailyNotes: { folder: '日記', template: '', filenamePattern: bad },
      });
      expect(res.statusCode).toBe(400);
    }
  }, 30_000);

  it('ライブラリ設定に保護パス(.git/config等)のテンプレは400で拒否される', async () => {
    for (const bad of ['.git/config', '.tsumiwiki/settings.yaml', '../secret.md']) {
      const res = await apiAs(admin, 'PUT', '/api/library/settings', {
        templates: { folder: '_templates' },
        dailyNotes: { folder: '日記', template: bad, filenamePattern: 'YYYY-MM-DD' },
      });
      expect(res.statusCode).toBe(400);
    }
  }, 30_000);
});

describe('デイリーノートAPI(日付指定)', () => {
  it('未認証は401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/daily-notes/by-date',
      headers: CSRF,
      payload: { date: '2020-01-01' },
    });
    expect(res.statusCode).toBe(401);
  }, 20_000);

  it('date が不正な形式なら400', async () => {
    for (const bad of ['', '2026-1-1', '2026-13-01', '2026/01/01']) {
      const res = await apiAs(yamada, 'POST', '/api/daily-notes/by-date', { date: bad });
      expect(res.statusCode).toBe(400);
    }
  }, 30_000);

  it('実在しない暦日(2月30日・平年うるう日)は400で拒否される', async () => {
    // 正規表現は通るが new Date() の overflow で別月に振り替わるケース。
    // regex を将来緩めた時にこの検証層のデグレを拾えるよう独立ケースとして残す
    for (const bad of ['2026-02-30', '2021-02-29', '2026-04-31']) {
      const res = await apiAs(yamada, 'POST', '/api/daily-notes/by-date', { date: bad });
      expect(res.statusCode).toBe(400);
    }
  }, 30_000);

  it('存在しない日付を指定すると新規作成される', async () => {
    const res = await apiAs(yamada, 'POST', '/api/daily-notes/by-date', { date: '2020-01-01' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: '日記/2020-01-01.md' });

    const tree = await apiAs(yamada, 'GET', '/api/tree');
    expect(tree.json().docs.map((d: { path: string }) => d.path)).toContain('日記/2020-01-01.md');
  }, 30_000);

  it('同じ日付を2回叩くと2回目は409 DAILY_NOTE_EXISTS', async () => {
    const first = await apiAs(yamada, 'POST', '/api/daily-notes/by-date', { date: '2021-05-10' });
    expect(first.statusCode).toBe(200);

    const second = await apiAs(yamada, 'POST', '/api/daily-notes/by-date', { date: '2021-05-10' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('DAILY_NOTE_EXISTS');
  }, 30_000);

  it('todayで作成済みの今日をby-dateで指定すると409になる', async () => {
    const todayRes = await apiAs(yamada, 'POST', '/api/daily-notes/today');
    expect(todayRes.statusCode).toBe(200);
    expect(todayRes.json().created).toBe(true);

    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const todayStr = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;

    const byDateRes = await apiAs(yamada, 'POST', '/api/daily-notes/by-date', { date: todayStr });
    expect(byDateRes.statusCode).toBe(409);
    expect(byDateRes.json().error.code).toBe('DAILY_NOTE_EXISTS');
  }, 30_000);

  it('テンプレを設定していれば指定日付で変数展開して作成する', async () => {
    await apiAs(admin, 'POST', '/api/docs', { folder: '_templates', title: '日誌' });
    const tmplPath = '_templates/日誌.md';
    await apiAs(admin, 'POST', '/api/locks', { path: tmplPath });
    const tmplBody = '---\ndate: {{date}}\n---\n\n# {{title}}\n\n担当: {{user}}\n\n本日の記録:\n';
    const getRes = await apiAs(admin, 'GET', `/api/docs?path=${encodeURIComponent(tmplPath)}`);
    await apiAs(admin, 'PUT', '/api/docs', {
      path: tmplPath,
      body: tmplBody,
      tags: [],
      baseUpdatedAt: getRes.json().updatedAt,
    });

    await apiAs(admin, 'PUT', '/api/library/settings', {
      templates: { folder: '_templates' },
      dailyNotes: {
        folder: '日記',
        template: tmplPath,
        filenamePattern: 'YYYY-MM-DD',
      },
    });

    const res = await apiAs(yamada, 'POST', '/api/daily-notes/by-date', { date: '2020-03-15' });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe('日記/2020-03-15.md');

    const doc = await apiAs(yamada, 'GET', `/api/docs?path=${encodeURIComponent(res.json().path)}`);
    const body = doc.json().body;
    expect(body).toContain('# 2020-03-15');
    expect(body).toContain('担当: 山田');
    expect(body).toContain('date: 2020-03-15');
  }, 30_000);

  it('filenamePatternがサブフォルダを含む場合も指定日付で階層に作成される', async () => {
    await apiAs(admin, 'PUT', '/api/library/settings', {
      templates: { folder: '_templates' },
      dailyNotes: { folder: '日記', template: '', filenamePattern: 'YYYY/MM/DD' },
    });
    const res = await apiAs(yamada, 'POST', '/api/daily-notes/by-date', { date: '2020-03-15' });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe('日記/2020/03/15.md');
  }, 30_000);
});
