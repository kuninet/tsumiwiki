import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIBRARY_SETTINGS_DEFAULTS } from '@tsumiwiki/shared';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';

// #84 Phase 1: ライブラリ設定 API のテスト

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
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-libset-'));
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

describe('ライブラリ設定API', () => {
  it('初期状態はデフォルト値が返る(corrupted: false)', async () => {
    const res = await apiAs(yamada, 'GET', '/api/library/settings');
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual(LIBRARY_SETTINGS_DEFAULTS);
    expect(res.json().corrupted).toBe(false);
  }, 20_000);

  // #99: settings.yaml が壊れている場合、サイレントにデフォルト値へフォールバックすると
  //      admin がそれと気付かず保存し、git上の正しい過去版を上書きしてしまう。
  //      GETレスポンスに corrupted: true が乗ることを確認する。
  it('settings.yamlが不正なYAMLの場合、corrupted: trueでデフォルト値が返る', async () => {
    await mkdir(join(lib, '.tsumiwiki'), { recursive: true });
    await writeFile(join(lib, '.tsumiwiki/settings.yaml'), 'templates: [unterminated\n', 'utf8');

    const res = await apiAs(yamada, 'GET', '/api/library/settings');
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual(LIBRARY_SETTINGS_DEFAULTS);
    expect(res.json().corrupted).toBe(true);
  }, 20_000);

  it('adminは設定を更新できる。以後の取得で反映される', async () => {
    const next = {
      templates: { folder: 'テンプレ' },
      dailyNotes: {
        folder: '日々',
        template: 'テンプレ/日誌.md',
        filenamePattern: 'YYYY年MM月DD日',
      },
    };
    const updated = await apiAs(admin, 'PUT', '/api/library/settings', next);
    expect(updated.statusCode).toBe(200);
    expect(updated.json().settings).toEqual(next);

    const fetched = await apiAs(yamada, 'GET', '/api/library/settings');
    expect(fetched.json().settings).toEqual(next);
  }, 20_000);

  it('一般ユーザーは更新できない(403)', async () => {
    const res = await apiAs(yamada, 'PUT', '/api/library/settings', LIBRARY_SETTINGS_DEFAULTS);
    expect(res.statusCode).toBe(403);
  }, 20_000);

  it('バリデーション違反は400(型が不正)', async () => {
    const res = await apiAs(admin, 'PUT', '/api/library/settings', {
      templates: { folder: '_templates' },
      dailyNotes: { folder: '日記', template: '', filenamePattern: 123 },
    });
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it('未認証は401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/library/settings',
      headers: CSRF,
    });
    expect(res.statusCode).toBe(401);
  }, 20_000);
});
