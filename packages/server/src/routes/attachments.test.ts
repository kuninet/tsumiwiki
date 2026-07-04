import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';

// 添付アップロード・ファイル配信APIのテスト(FR-IMG / FR-OBS-05)

const CSRF = { 'x-requested-with': 'TsumiWiki' };

type App = ReturnType<typeof buildApp>;
let app: App;
let lib: string;
let cookie: string;
let docPath: string;

// app.inject用のmultipartボディを組み立てる
function multipart(fields: Record<string, string>, file: { name: string; content: Buffer }) {
  const boundary = 'tsumiwiki-test-boundary';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
  );
  parts.push(file.content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function setup(env: Record<string, string> = {}) {
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-attach-'));
  const config = loadConfig({ LIBRARY_PATH: lib, ...env });
  const db = openDatabase(':memory:');
  app = buildApp({ config, db, logger: false });
  await app.ready();
  app.userService.create({ username: 'yamada', displayName: '山田', password: 'p', role: 'user' });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: CSRF,
    payload: { username: 'yamada', password: 'p' },
  });
  cookie = (login.headers['set-cookie'] as string).split(';')[0];
  const created = await app.inject({
    method: 'POST',
    url: '/api/docs',
    headers: { ...CSRF, cookie },
    payload: { folder: '議事録', title: '添付先' },
  });
  docPath = created.json().path;
}

beforeEach(async () => {
  await setup();
});

afterEach(async () => {
  await app.close();
  await rm(lib, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('添付アップロード', () => {
  it('文書と同じフォルダへ保存され、attach:コミットが積まれる', async () => {
    const mp = multipart({ docPath }, { name: 'スクショ.png', content: PNG });
    const res = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...CSRF, cookie, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(201);
    const { fileName, path: relPath } = res.json();
    expect(fileName).toMatch(/^image-\d{14}\.png$/);
    expect(relPath).toBe(`議事録/${fileName}`);

    const files = await readdir(join(lib, '議事録'));
    expect(files).toContain(fileName);

    const history = await app.gitService.history(relPath);
    expect(history[0].message).toBe(`attach: ${relPath}`);
  }, 30_000);

  it('非対応の拡張子は400', async () => {
    const mp = multipart({ docPath }, { name: 'evil.exe', content: PNG });
    const res = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...CSRF, cookie, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it('サイズ上限を超えると413', async () => {
    await app.close();
    await rm(lib, { recursive: true, force: true });
    await setup({ MAX_UPLOAD_MB: '1' });

    const big = Buffer.alloc(2 * 1024 * 1024, 1);
    const mp = multipart({ docPath }, { name: 'big.png', content: big });
    const res = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...CSRF, cookie, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(413);
  }, 30_000);

  it('ATTACHMENT_DIR_MODE指定時はそのフォルダへ保存される', async () => {
    await app.close();
    await rm(lib, { recursive: true, force: true });
    await setup({ ATTACHMENT_DIR_MODE: 'attachments' });

    const mp = multipart({ docPath }, { name: 'a.png', content: PNG });
    const res = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...CSRF, cookie, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().path).toMatch(/^attachments\/image-/);
  }, 30_000);
});

describe('ファイル配信', () => {
  it('アップロードした画像が配信され、安全ヘッダが付く', async () => {
    const mp = multipart({ docPath }, { name: 'a.png', content: PNG });
    const up = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...CSRF, cookie, ...mp.headers },
      payload: mp.payload,
    });
    const relPath = up.json().path;

    const res = await app.inject({
      method: 'GET',
      url: `/api/files/${relPath.split('/').map(encodeURIComponent).join('/')}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.rawPayload.equals(PNG)).toBe(true);
  }, 30_000);

  it('Markdown・保護パス・トラバーサルは配信しない', async () => {
    const cases: [string, number][] = [
      [`/api/files/${encodeURIComponent(docPath)}`, 404], // .md
      ['/api/files/.git/config', 404],
      ['/api/files/.obsidian/app.json', 404],
      ['/api/files/..%2Foutside.png', 400],
    ];
    for (const [url, status] of cases) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode).toBe(status);
    }
  }, 20_000);

  it('未認証ではファイル配信されない', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/files/x.png' });
    expect(res.statusCode).toBe(401);
  }, 20_000);
});
