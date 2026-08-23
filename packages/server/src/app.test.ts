import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@tsumiwiki/shared';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';

function buildTestApp() {
  const config = loadConfig({ LIBRARY_PATH: mkdtempSync(join(tmpdir(), 'tsumiwiki-app-')) });
  const db = openDatabase(':memory:');
  return buildApp({ config, db, logger: false });
}

describe('GET /api/health', () => {
  it('スキーマに適合したヘルスチェック応答を返す', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    const body = healthResponseSchema.parse(res.json());
    expect(body.status).toBe('ok');
    expect(body.name).toBe('tsumiwiki');
  });
});

describe('想定外の例外のレスポンス(issue #206)', () => {
  it('OS のエラー文字列や絶対パスを返さず固定文言の 500 になる', async () => {
    const app = buildTestApp();
    app.get('/boom-test', async () => {
      throw new Error("ENAMETOOLONG: name too long, rename '/Users/secret/library/x.png'");
    });
    const res = await app.inject({ method: 'GET', url: '/boom-test' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'サーバー内部でエラーが発生しました' },
    });
    expect(res.body).not.toContain('/Users/secret');
  });

  it('Error 以外の値が throw されても 200 にならず 500 になる', async () => {
    const app = buildTestApp();
    app.get('/boom-object', async () => {
      throw { statusCode: 418, message: 'teapot' };
    });
    const res = await app.inject({ method: 'GET', url: '/boom-object' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
  });

  it('Fastify 由来の 4xx(不正な JSON)は従来どおり 400 のまま', async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'TsumiWiki' },
      payload: '{broken',
    });
    expect(res.statusCode).toBe(400);
  });
});
