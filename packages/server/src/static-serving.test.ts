import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';

// 静的配信+SPAフォールバックのテスト(#36 / 設計01章1.4)

let lib: string;
let staticDir: string;
let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-static-lib-'));
  staticDir = await mkdtemp(join(tmpdir(), 'tsumiwiki-static-'));
  await writeFile(join(staticDir, 'index.html'), '<html><body>TsumiWiki SPA</body></html>', 'utf8');
  await mkdir(join(staticDir, 'assets'), { recursive: true });
  await writeFile(join(staticDir, 'assets', 'app.js'), 'console.log(1);', 'utf8');

  const config = loadConfig({ LIBRARY_PATH: lib, STATIC_ROOT: staticDir });
  app = buildApp({ config, db: openDatabase(':memory:'), logger: false });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(staticDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('静的配信', () => {
  it('ルートでindex.htmlが配信される', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('TsumiWiki SPA');
  });

  it('アセットが配信される', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
  });

  it('SPAルート(/doc/... 等)はindex.htmlへフォールバックする', async () => {
    for (const url of ['/doc/%E8%AD%B0%E4%BA%8B%E9%8C%B2/x.md', '/trash', '/admin/users']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('TsumiWiki SPA');
    }
  });

  it('未知の/apiパスはHTMLフォールバックせずJSONエラーを返す', async () => {
    // 未認証は認証フックが先に401を返す(妥当)。SPAのindex.htmlに
    // フォールバックしないこと=JSONエラーであることを確認する
    const res = await app.inject({ method: 'GET', url: '/api/unknown' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');

    // 認証済みなら404のJSON
    app.userService.create({ username: 'u', displayName: 'U', password: 'p', role: 'user' });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-requested-with': 'TsumiWiki' },
      payload: { username: 'u', password: 'p' },
    });
    const cookie = (login.headers['set-cookie'] as string).split(';')[0];
    const res2 = await app.inject({ method: 'GET', url: '/api/unknown', headers: { cookie } });
    expect(res2.statusCode).toBe(404);
    expect(res2.json().error.code).toBe('NOT_FOUND');
  });

  it('STATIC_ROOT未指定(存在しない)なら静的配信は無効でAPIは動く', async () => {
    const config = loadConfig({ LIBRARY_PATH: lib, STATIC_ROOT: undefined as never });
    // モノレポ内のclient/distが存在する場合は自動検出されるため、このテストでは
    // 検出結果に関わらずAPIが動作することのみ確認する
    const app2 = buildApp({ config, db: openDatabase(':memory:'), logger: false });
    const res = await app2.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    await app2.close();
  });
});

describe('レビュー指摘の回帰テスト', () => {
  it('存在しないビルドアセットは404(index.htmlへフォールバックしない)', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/missing.js' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('TsumiWiki SPA');
  });

  it('ドットファイルは配信されない', async () => {
    const { writeFile: wf } = await import('node:fs/promises');
    const { join: j } = await import('node:path');
    await wf(j(staticDir, '.env'), 'SECRET=1', 'utf8');
    const res = await app.inject({ method: 'GET', url: '/.env' });
    expect(res.body).not.toContain('SECRET');
  });

  it('/API/(大文字)もJSONエラーになる', async () => {
    const res = await app.inject({ method: 'GET', url: '/API/unknown' });
    expect(res.headers['content-type']).toContain('application/json');
  });
});
