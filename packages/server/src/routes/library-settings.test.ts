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

  it('adminは設定を更新できる。以降の取得で反映される', async () => {
    const next = {
      templates: { folder: 'テンプレ' },
      dailyNotes: {
        folder: '日々',
        template: 'テンプレ/日誌.md',
        filenamePattern: 'YYYY年MM月DD日',
      },
      attachments: {
        mode: 'doc-subfolder' as const,
        folder: 'media',
      },
    };
    const updated = await apiAs(admin, 'PUT', '/api/library/settings', next);
    expect(updated.statusCode).toBe(200);
    expect(updated.json().settings).toEqual(next);

    const fetched = await apiAs(yamada, 'GET', '/api/library/settings');
    expect(fetched.json().settings).toEqual(next);
  }, 20_000);

  it('attachments を省略した旧形式 PUT でも現在値（既定または環境変数フォールバック）が維持される', async () => {
    const legacyPayload = {
      templates: { folder: 'テンプレ' },
      dailyNotes: {
        folder: '日々',
        template: '',
        filenamePattern: 'YYYY-MM-DD',
      },
    };
    const updated = await apiAs(admin, 'PUT', '/api/library/settings', legacyPayload);
    expect(updated.statusCode).toBe(200);
    expect(updated.json().settings).toEqual({
      ...legacyPayload,
      attachments: LIBRARY_SETTINGS_DEFAULTS.attachments,
    });

    // 既に doc-subfolder が設定された状態で旧形式 PUT を送っても上書きされない
    const withSub = {
      ...legacyPayload,
      attachments: { mode: 'doc-subfolder' as const, folder: 'media' },
    };
    expect((await apiAs(admin, 'PUT', '/api/library/settings', withSub)).statusCode).toBe(200);
    const afterLegacy = await apiAs(admin, 'PUT', '/api/library/settings', legacyPayload);
    expect(afterLegacy.statusCode).toBe(200);
    expect(afterLegacy.json().settings.attachments).toEqual({
      mode: 'doc-subfolder',
      folder: 'media',
    });
  }, 20_000);

  it('ATTACHMENT_DIR_MODE=assets 運用時に attachments 省略 PUT を送っても vault-folder/assets が維持される', async () => {
    const envLib = await mkdtemp(join(tmpdir(), 'tsumiwiki-libset-env-'));
    const envApp = buildApp({
      config: loadConfig({ LIBRARY_PATH: envLib, ATTACHMENT_DIR_MODE: 'assets' }),
      db: openDatabase(':memory:'),
      logger: false,
    });
    try {
      await envApp.ready();
      envApp.userService.create({
        username: 'admin',
        displayName: '管理者',
        password: 'p',
        role: 'admin',
      });
      const loginRes = await envApp.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: CSRF,
        payload: { username: 'admin', password: 'p' },
      });
      const envAdminCookie = (loginRes.headers['set-cookie'] as string).split(';')[0];

      const legacyPayload = {
        templates: { folder: 'テンプレ' },
        dailyNotes: {
          folder: '日々',
          template: '',
          filenamePattern: 'YYYY-MM-DD',
        },
      };
      const putRes = await envApp.inject({
        method: 'PUT',
        url: '/api/library/settings',
        headers: { ...CSRF, cookie: envAdminCookie },
        payload: legacyPayload,
      });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.json().settings.attachments).toEqual({
        mode: 'vault-folder',
        folder: 'assets',
      });
    } finally {
      await envApp.close();
      await rm(envLib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
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

  it('添付フォルダの不正値・テンプレートフォルダ衝突は 400 で拒否される', async () => {
    const invalidCases = [
      { mode: 'vault-folder', folder: '.trash' },
      { mode: 'vault-folder', folder: '../out' },
      { mode: 'vault-folder', folder: '' },
      { mode: 'vault-folder', folder: '_templates' },
      { mode: 'doc-subfolder', folder: '.hidden' },
    ];
    for (const attachments of invalidCases) {
      const res = await apiAs(admin, 'PUT', '/api/library/settings', {
        templates: { folder: '_templates' },
        dailyNotes: { folder: '日記', template: '', filenamePattern: 'YYYY-MM-DD' },
        attachments,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    // 設定は変更されていないこと
    const current = await apiAs(yamada, 'GET', '/api/library/settings');
    expect(current.json().settings).toEqual(LIBRARY_SETTINGS_DEFAULTS);
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
