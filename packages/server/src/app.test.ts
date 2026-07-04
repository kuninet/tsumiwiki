import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@tsumiwiki/shared';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';

function buildTestApp() {
  const config = loadConfig({ LIBRARY_PATH: '/tmp/test-library' });
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
