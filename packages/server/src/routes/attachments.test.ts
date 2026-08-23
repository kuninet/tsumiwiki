import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  await rm(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

describe('添付アップロード', () => {
  it('文書と同じフォルダへ保存され、attach:コミットが積まれる', async () => {
    const mp = multipart({}, { name: 'スクショ.png', content: PNG });
    const res = await app.inject({
      method: 'POST',
      url: `/api/attachments?docPath=${encodeURIComponent(docPath)}`,
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
    const mp = multipart({}, { name: 'evil.exe', content: PNG });
    const res = await app.inject({
      method: 'POST',
      url: `/api/attachments?docPath=${encodeURIComponent(docPath)}`,
      headers: { ...CSRF, cookie, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it('サイズ上限を超えると413', async () => {
    await app.close();
    await rm(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await setup({ MAX_UPLOAD_MB: '1' });

    const big = Buffer.alloc(2 * 1024 * 1024, 1);
    const mp = multipart({}, { name: 'big.png', content: big });
    const res = await app.inject({
      method: 'POST',
      url: `/api/attachments?docPath=${encodeURIComponent(docPath)}`,
      headers: { ...CSRF, cookie, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(413);
  }, 30_000);

  it('ATTACHMENT_DIR_MODE指定時はそのフォルダへ保存される', async () => {
    await app.close();
    await rm(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await setup({ ATTACHMENT_DIR_MODE: 'attachments' });

    const mp = multipart({}, { name: 'a.png', content: PNG });
    const res = await app.inject({
      method: 'POST',
      url: `/api/attachments?docPath=${encodeURIComponent(docPath)}`,
      headers: { ...CSRF, cookie, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().path).toMatch(/^attachments\/image-/);
  }, 30_000);
});

describe('ファイル配信', () => {
  it('アップロードした画像が配信され、安全ヘッダが付く', async () => {
    const mp = multipart({}, { name: 'a.png', content: PNG });
    const up = await app.inject({
      method: 'POST',
      url: `/api/attachments?docPath=${encodeURIComponent(docPath)}`,
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
    {
      const csp = parseCsp(res.headers['content-security-policy'] as string | undefined);
      expect(csp['default-src']).toEqual(["'none'"]);
      expect(csp['style-src']).toEqual(["'unsafe-inline'"]);
      // 画像・SVG系にはPDF用のscript-src等が混入しないこと(緩めていない)
      expect(csp['script-src']).toBeUndefined();
    }
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


// CSPヘッダを`;`区切りでディレクティブごとにパースする。値内空白は分割済みSet化。
// 「toContain」検査は将来 CSP を緩めた変更を素通しするため、必ずこのヘルパで
// 期待ディレクティブ集合と等価比較する
function parseCsp(header: string | undefined): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  if (!header) return map;
  for (const raw of header.split(';')) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length === 0 || !parts[0]) continue;
    const name = parts[0].toLowerCase();
    map[name] = parts.slice(1);
  }
  return map;
}

describe('レビュー指摘の回帰テスト', () => {
  const upload = (name: string, content: Buffer, target = docPath) => {
    const mp = multipart({}, { name, content });
    return app.inject({
      method: 'POST',
      url: `/api/attachments?docPath=${encodeURIComponent(target)}`,
      headers: { ...CSRF, cookie, ...mp.headers },
      payload: mp.payload,
    });
  };

  it('SVGはCSP付きで配信され、直接ナビゲーションはダウンロード扱い', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const up = await upload('攻撃.svg', svg);
    expect(up.statusCode).toBe(201);

    const res = await app.inject({
      method: 'GET',
      url: `/api/files/${up.json().path.split('/').map(encodeURIComponent).join('/')}`,
      headers: { cookie },
    });
    expect(res.headers['content-type']).toContain('image/svg+xml');
    {
      const csp = parseCsp(res.headers['content-security-policy'] as string | undefined);
      expect(csp['default-src']).toEqual(["'none'"]);
      expect(csp['style-src']).toEqual(["'unsafe-inline'"]);
      expect(csp['script-src']).toBeUndefined();
    }
    expect(res.headers['content-disposition']).toBe('attachment');
  }, 30_000);

  it('存在しない文書への添付は404', async () => {
    const res = await upload('a.png', PNG, '存在しない.md');
    expect(res.statusCode).toBe(404);
  }, 20_000);

  it('docPath欠落は400(ファイルが先でも順序に依存しない)', async () => {
    const mp = multipart({}, { name: 'a.png', content: PNG });
    const res = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...CSRF, cookie, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it('ファイル名にトラバーサルが含まれても無害化される(サーバー生成名で保存)', async () => {
    const res = await upload('..%2F..%2Fevil.png'.replace(/%2F/g, '/'), PNG);
    expect(res.statusCode).toBe(201);
    expect(res.json().fileName).toMatch(/^image-\d{14}(-\d+)?\.png$/);
    expect(res.json().path.startsWith('議事録/')).toBe(true);
  }, 20_000);

  it('未知拡張子・ディレクトリは配信しない', async () => {
    const { writeFile: wf, mkdir: md } = await import('node:fs/promises');
    await wf(join(lib, 'メモ.txt'), 'x', 'utf8');
    await md(join(lib, 'サブ'), { recursive: true });
    for (const target of ['メモ.txt', 'サブ']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/files/${encodeURIComponent(target)}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
    }
  }, 20_000);
});

describe('GET /api/embed(issue #198 添付索引による解決)', () => {
  const upload = (name: string, content: Buffer, target = docPath) => {
    const mp = multipart({}, { name, content });
    return app.inject({
      method: 'POST',
      url: `/api/attachments?docPath=${encodeURIComponent(target)}`,
      headers: { ...CSRF, cookie, ...mp.headers },
      payload: mp.payload,
    });
  };

  it('同フォルダ配置の画像を解決して配信する', async () => {
    // 保存ファイル名はサーバー生成(image-YYYYMMDDHHmmss.png)のため実際の名前で解決する
    const up = await upload('同フォルダ.png', PNG);
    expect(up.statusCode).toBe(201);
    const fileName = up.json().fileName as string;

    const res = await app.inject({
      method: 'GET',
      url: `/api/embed?target=${encodeURIComponent(fileName)}&from=${encodeURIComponent(docPath)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.rawPayload.equals(PNG)).toBe(true);
  }, 20_000);

  it('2配置(ルート・サブフォルダ)を名前一致・パス指定・パス末尾一致・fromなしの4通りで解決できる', async () => {
    const { writeFile: wf, mkdir: md } = await import('node:fs/promises');
    await wf(join(lib, 'ルート配置.png'), PNG); // ルート
    await app.indexerService.indexAttachment('ルート配置.png');
    await md(join(lib, 'attachments'), { recursive: true });
    await wf(join(lib, 'attachments', '別フォルダ配置.png'), PNG);
    await app.indexerService.indexAttachment('attachments/別フォルダ配置.png');

    // ルート配置(参照元は議事録配下だが、ヴォルト全体から名前一致で解決)
    const r1 = await app.inject({
      method: 'GET',
      url: `/api/embed?target=${encodeURIComponent('ルート配置.png')}&from=${encodeURIComponent(docPath)}`,
      headers: { cookie },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.rawPayload.equals(PNG)).toBe(true);

    // フォルダ内配置(パス指定)
    const r2 = await app.inject({
      method: 'GET',
      url: `/api/embed?target=${encodeURIComponent('attachments/別フォルダ配置.png')}`,
      headers: { cookie },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.rawPayload.equals(PNG)).toBe(true);

    // ファイル名のみでのパス末尾一致解決
    const r3 = await app.inject({
      method: 'GET',
      url: `/api/embed?target=${encodeURIComponent('別フォルダ配置.png')}`,
      headers: { cookie },
    });
    expect(r3.statusCode).toBe(200);
    expect(r3.rawPayload.equals(PNG)).toBe(true);

    // fromなしでも名前一致だけで解決できる
    const r4 = await app.inject({
      method: 'GET',
      url: `/api/embed?target=${encodeURIComponent('ルート配置.png')}`,
      headers: { cookie },
    });
    expect(r4.statusCode).toBe(200);
    expect(r4.rawPayload.equals(PNG)).toBe(true);
  }, 20_000);

  it('未登録のtargetは404、targetなしは400、.mdを指すtargetは404', async () => {
    const notFound = await app.inject({
      method: 'GET',
      url: `/api/embed?target=${encodeURIComponent('存在しない.png')}`,
      headers: { cookie },
    });
    expect(notFound.statusCode).toBe(404);

    const noTarget = await app.inject({
      method: 'GET',
      url: '/api/embed',
      headers: { cookie },
    });
    expect(noTarget.statusCode).toBe(400);

    // .mdはattachment_indexに入らないため、名前が一致しても解決されず404
    const mdTarget = await app.inject({
      method: 'GET',
      url: `/api/embed?target=${encodeURIComponent(docPath.split('/').pop() ?? '')}`,
      headers: { cookie },
    });
    expect(mdTarget.statusCode).toBe(404);
  }, 20_000);

  it('targetを配列で複数指定(?target=a&target=b)すると400になる', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/embed?target=a.png&target=b.png',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it('索引にあるが実体が消えたファイルへの解決は404', async () => {
    const up = await upload('消える画像.png', PNG);
    expect(up.statusCode).toBe(201);
    const relPath = up.json().path as string;
    // 索引を更新せずファイル実体だけ消す(索引が実体より古い状態を再現)
    await rm(join(lib, relPath), { force: true });

    const res = await app.inject({
      method: 'GET',
      url: `/api/embed?target=${encodeURIComponent(relPath.split('/').pop() ?? '')}&from=${encodeURIComponent(docPath)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  }, 20_000);

  it('アップロード直後に索引が反映され、/api/embedで即座に解決できる', async () => {
    const up = await upload('即時反映.png', PNG);
    expect(up.statusCode).toBe(201);
    const fileName = up.json().fileName as string;

    const res = await app.inject({
      method: 'GET',
      url: `/api/embed?target=${encodeURIComponent(fileName)}&from=${encodeURIComponent(docPath)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG)).toBe(true);
  }, 20_000);

  it('未認証では解決されない', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/embed?target=x.png' });
    expect(res.statusCode).toBe(401);
  }, 20_000);
});

// 添付管理(名前変更・削除・参照調査)のテスト(issue #199)

function api(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { ...CSRF, cookie },
    payload: payload as never,
  });
}

// 保存はロック保持が前提(FR-LOCK)。ロック取得してからPUTするヘルパー(docs.test.tsと同じ流儀)
async function saveDoc(payload: { path: string; [k: string]: unknown }) {
  await api('POST', '/api/locks', { path: payload.path });
  return api('PUT', '/api/docs', payload);
}

async function uploadTo(target: string, name = '画像.png') {
  const mp = multipart({}, { name, content: PNG });
  const res = await app.inject({
    method: 'POST',
    url: `/api/attachments?docPath=${encodeURIComponent(target)}`,
    headers: { ...CSRF, cookie, ...mp.headers },
    payload: mp.payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { fileName: string; path: string };
}

describe('GET /api/attachments/resolve(issue #199)', () => {
  it('解決成功時はpathとnameを返す', async () => {
    const up = await uploadTo(docPath);
    const res = await api(
      'GET',
      `/api/attachments/resolve?target=${encodeURIComponent(up.fileName)}&from=${encodeURIComponent(docPath)}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: up.path, name: up.fileName });
  }, 20_000);

  it('未登録のtargetは404', async () => {
    const res = await api('GET', `/api/attachments/resolve?target=${encodeURIComponent('存在しない.png')}`);
    expect(res.statusCode).toBe(404);
  }, 20_000);

  it('targetなしは400', async () => {
    const res = await api('GET', '/api/attachments/resolve');
    expect(res.statusCode).toBe(400);
  }, 20_000);
});

describe('GET /api/attachments/references(issue #199)', () => {
  it('同フォルダのMarkdown画像参照を検出する', async () => {
    const up = await uploadTo(docPath);
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(docPath)}`);
    await saveDoc({
      path: docPath,
      body: `![説明](${up.fileName})\n`,
      tags: [],
      baseUpdatedAt: got.json().updatedAt,
    });

    const res = await api('GET', `/api/attachments/references?path=${encodeURIComponent(up.path)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().docs).toEqual([docPath]);
  }, 20_000);

  it('パス指定・[[x.png]]形式でも検出する', async () => {
    const up = await uploadTo(docPath);
    await api('POST', '/api/docs', { folder: '別部屋', title: '別文書' });
    const otherPath = '別部屋/別文書.md';
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(otherPath)}`);
    await saveDoc({
      path: otherPath,
      body: `[[${up.path}]]\n`,
      tags: [],
      baseUpdatedAt: got.json().updatedAt,
    });

    const res = await api('GET', `/api/attachments/references?path=${encodeURIComponent(up.path)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().docs).toEqual([otherPath]);
  }, 20_000);

  it('同名別フォルダの画像は含まれない', async () => {
    const up = await uploadTo(docPath, '同名.png');
    await api('POST', '/api/folders', { path: '別フォルダ' });
    await writeFile(join(lib, '別フォルダ', up.fileName), PNG);
    await app.indexerService.indexAttachment(`別フォルダ/${up.fileName}`);

    await api('POST', '/api/docs', { folder: '別フォルダ', title: '参照文書' });
    const otherDocPath = '別フォルダ/参照文書.md';
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(otherDocPath)}`);
    // ファイル名だけの参照は同フォルダの別実体(別フォルダ側)へ解決される
    await saveDoc({
      path: otherDocPath,
      body: `![[${up.fileName}]]\n`,
      tags: [],
      baseUpdatedAt: got.json().updatedAt,
    });

    const res = await api('GET', `/api/attachments/references?path=${encodeURIComponent(up.path)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().docs).toEqual([]);
  }, 20_000);

  it('未参照の添付は空配列', async () => {
    const up = await uploadTo(docPath);
    const res = await api('GET', `/api/attachments/references?path=${encodeURIComponent(up.path)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().docs).toEqual([]);
  }, 20_000);

  it('不正パスは400', async () => {
    const res = await api('GET', `/api/attachments/references?path=${encodeURIComponent('../outside.png')}`);
    expect(res.statusCode).toBe(400);
  }, 20_000);
});

describe('POST /api/attachments/rename(issue #199)', () => {
  it('参照文書2件のリンク(alias付き埋め込み・wikilink・パス指定画像)を書き換え、1コミットにまとまる', async () => {
    const up = await uploadTo(docPath);

    await api('POST', '/api/docs', { folder: '議事録', title: '参照文書A' });
    const docA = '議事録/参照文書A.md';
    const gotA = await api('GET', `/api/docs?path=${encodeURIComponent(docA)}`);
    await saveDoc({
      path: docA,
      body: `![[${up.fileName}|300]]\n[[${up.fileName}]]\n`,
      tags: [],
      baseUpdatedAt: gotA.json().updatedAt,
    });

    await api('POST', '/api/docs', { folder: '別部屋', title: '参照文書B' });
    const docB = '別部屋/参照文書B.md';
    const gotB = await api('GET', `/api/docs?path=${encodeURIComponent(docB)}`);
    await saveDoc({
      path: docB,
      body: `![説明](${up.path})\n`,
      tags: [],
      baseUpdatedAt: gotB.json().updatedAt,
    });

    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: '新しい画像.png' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe('議事録/新しい画像.png');
    expect(body.name).toBe('新しい画像.png');
    expect(body.rewrittenDocs.map((d: { path: string }) => d.path).sort()).toEqual([docA, docB].sort());

    const files = await readdir(join(lib, '議事録'));
    expect(files).toContain('新しい画像.png');
    expect(files).not.toContain(up.fileName);

    const bodyA = (await api('GET', `/api/docs?path=${encodeURIComponent(docA)}`)).json().body;
    expect(bodyA).toContain('![[新しい画像.png|300]]');
    expect(bodyA).toContain('[[新しい画像.png]]');

    const bodyB = (await api('GET', `/api/docs?path=${encodeURIComponent(docB)}`)).json().body;
    expect(bodyB).toContain('![説明](議事録/新しい画像.png)');

    // 1コミットにまとまる
    const history = await app.gitService.history('議事録/新しい画像.png');
    expect(history[0].message).toBe(`rename attachment: ${up.path} -> 議事録/新しい画像.png`);
  }, 30_000);

  it('フロントマターとCRLFは保持される', async () => {
    const up = await uploadTo(docPath, 'crlf対象.png');
    await writeFile(
      join(lib, 'CRLF参照.md'),
      `---\r\ntags: [x]\r\n---\r\n\r\n見出し\r\n![[${up.fileName}]]\r\n本文\r\n`,
      'utf8',
    );
    await app.indexerService.indexFile('CRLF参照.md');

    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: 'crlf変更後.png' });
    expect(res.statusCode).toBe(200);

    const raw = await readFile(join(lib, 'CRLF参照.md'), 'utf8');
    expect(raw).toContain('\r\n');
    expect(raw).toContain('tags: [x]');
    expect(raw).toContain('![[crlf変更後.png]]');
  }, 20_000);

  it('同名衝突は409', async () => {
    const up = await uploadTo(docPath, 'A.png');
    const upB = await uploadTo(docPath, 'B.png');
    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: upB.fileName });
    expect(res.statusCode).toBe(409);
  }, 20_000);

  it('不正名(/入り)は400', async () => {
    const up = await uploadTo(docPath);
    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: 'a/b.png' });
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it('Windows予約名は400', async () => {
    const up = await uploadTo(docPath);
    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: 'CON.png' });
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it('拡張子の変更は400', async () => {
    const up = await uploadTo(docPath);
    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: '変更後.jpg' });
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it('拡張子省略時は元の拡張子を補う', async () => {
    const up = await uploadTo(docPath);
    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: '拡張子省略' });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('拡張子省略.png');
  }, 20_000);

  it('大文字小文字のみの変更ができる', async () => {
    const up = await uploadTo(docPath, 'case.PNG');
    const upper = up.fileName.toUpperCase();
    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: upper });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe(upper);
    const files = await readdir(join(lib, '議事録'));
    expect(files).toContain(upper);
  }, 20_000);

  it('未存在は404', async () => {
    const res = await api('POST', '/api/attachments/rename', {
      path: `議事録/${'存在しない.png'}`,
      newName: '新名.png',
    });
    expect(res.statusCode).toBe(404);
  }, 20_000);

  it('同名別フォルダの参照は書き換えられない', async () => {
    const up = await uploadTo(docPath, '共通名.png');
    await api('POST', '/api/folders', { path: '別フォルダ' });
    await writeFile(join(lib, '別フォルダ', up.fileName), PNG);
    await app.indexerService.indexAttachment(`別フォルダ/${up.fileName}`);

    await api('POST', '/api/docs', { folder: '別フォルダ', title: '参照文書' });
    const otherDocPath = '別フォルダ/参照文書.md';
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(otherDocPath)}`);
    await saveDoc({
      path: otherDocPath,
      body: `![[${up.fileName}]]\n`,
      tags: [],
      baseUpdatedAt: got.json().updatedAt,
    });

    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: '改名後.png' });
    expect(res.statusCode).toBe(200);
    expect(res.json().rewrittenDocs).toEqual([]);

    const otherBody = (await api('GET', `/api/docs?path=${encodeURIComponent(otherDocPath)}`)).json().body;
    expect(otherBody).toContain(`![[${up.fileName}]]`);
  }, 20_000);

  it('rewrittenDocs[].updatedAtは実際のmtimeと一致する', async () => {
    const up = await uploadTo(docPath);
    await api('POST', '/api/docs', { folder: '議事録', title: '参照文書C' });
    const docC = '議事録/参照文書C.md';
    const gotC = await api('GET', `/api/docs?path=${encodeURIComponent(docC)}`);
    await saveDoc({
      path: docC,
      body: `![[${up.fileName}]]\n`,
      tags: [],
      baseUpdatedAt: gotC.json().updatedAt,
    });

    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: '確認用.png' });
    expect(res.statusCode).toBe(200);
    const entry = res.json().rewrittenDocs.find((d: { path: string }) => d.path === docC);
    const doc = await api('GET', `/api/docs?path=${encodeURIComponent(docC)}`);
    expect(entry.updatedAt).toBe(doc.json().updatedAt);
  }, 20_000);
});

describe('DELETE /api/attachments(issue #199)', () => {
  it('.trashへ移動し、索引・/api/embedから消え、ごみ箱一覧に出て復元で再び解決できる', async () => {
    const up = await uploadTo(docPath, '削除対象.png');

    const del = await api('DELETE', `/api/attachments?path=${encodeURIComponent(up.path)}`);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });

    const files = await readdir(join(lib, '議事録'));
    expect(files).not.toContain(up.fileName);

    const embed = await api(
      'GET',
      `/api/embed?target=${encodeURIComponent(up.fileName)}&from=${encodeURIComponent(docPath)}`,
    );
    expect(embed.statusCode).toBe(404);

    const trash = await api('GET', '/api/trash');
    const entry = trash.json().entries.find((e: { name: string }) => e.name === up.fileName);
    expect(entry).toBeTruthy();
    expect(entry.originalPath).toBe(up.path);

    const restore = await api('POST', '/api/trash/restore', { trashPath: entry.trashPath });
    expect(restore.statusCode).toBe(200);

    const embedAfter = await api(
      'GET',
      `/api/embed?target=${encodeURIComponent(up.fileName)}&from=${encodeURIComponent(docPath)}`,
    );
    expect(embedAfter.statusCode).toBe(200);
  }, 20_000);

  it('未存在は404', async () => {
    const res = await api('DELETE', `/api/attachments?path=${encodeURIComponent('議事録/存在しない.png')}`);
    expect(res.statusCode).toBe(404);
  }, 20_000);
});

describe('添付管理APIの認証(issue #199)', () => {
  it('未認証はいずれも401', async () => {
    const resolve = await app.inject({ method: 'GET', url: '/api/attachments/resolve?target=x.png' });
    expect(resolve.statusCode).toBe(401);
    const references = await app.inject({ method: 'GET', url: '/api/attachments/references?path=x.png' });
    expect(references.statusCode).toBe(401);
    const rename = await app.inject({
      method: 'POST',
      url: '/api/attachments/rename',
      headers: CSRF,
      payload: { path: 'x.png', newName: 'y.png' },
    });
    expect(rename.statusCode).toBe(401);
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/attachments?path=x.png',
      headers: CSRF,
    });
    expect(del.statusCode).toBe(401);
  }, 20_000);
});

describe('Opusレビュー指摘の追加テスト(issue #199)', () => {
  it('【中2】コードブロック・インラインコード内の参照は検出・書き換えの対象外になる', async () => {
    const up = await uploadTo(docPath, 'コード内.png');

    await api('POST', '/api/docs', { folder: '議事録', title: 'コード混在文書' });
    const codeDoc = '議事録/コード混在文書.md';
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(codeDoc)}`);
    const body = [
      '```',
      `![[${up.fileName}]]`,
      '```',
      '',
      `\`![[${up.fileName}]]\` はインラインコード内`,
      '',
      `![[${up.fileName}]] は本物の参照`,
      '',
    ].join('\n');
    await saveDoc({ path: codeDoc, body, tags: [], baseUpdatedAt: got.json().updatedAt });

    // 参照検出: コード内のみを参照する文書は「未参照」にならない(本物の参照が1件あるため検出はされる)
    const refs = await api('GET', `/api/attachments/references?path=${encodeURIComponent(up.path)}`);
    expect(refs.json().docs).toEqual([codeDoc]);

    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: 'コード後.png' });
    expect(res.statusCode).toBe(200);

    const after = (await api('GET', `/api/docs?path=${encodeURIComponent(codeDoc)}`)).json().body as string;
    expect(after).toContain('```\n' + `![[${up.fileName}]]` + '\n```'); // フェンス内はそのまま残る
    expect(after).toContain(`\`![[${up.fileName}]]\` はインラインコード内`); // インラインコードもそのまま
    expect(after).toContain('![[コード後.png]] は本物の参照'); // フェンス外の本物だけ書き換わる
  }, 20_000);

  // root 実行環境では chmod による書き込み禁止が効かないためスキップする
  it.skipIf(process.getuid?.() === 0)('【中3】添付renameが失敗すると、書き換え済み文書とファイル名の両方がロールバックされる', async () => {
    const up = await uploadTo(docPath, 'ロールバック対象.png');

    // 参照文書はattachmentとは別フォルダに置く(議事録フォルダをrename直前に書き込み禁止に
    // するため、参照文書の書き換え自体はこの制約の影響を受けないようにする)
    await api('POST', '/api/docs', { folder: '別部屋', title: 'ロールバック参照文書' });
    const refDoc = '別部屋/ロールバック参照文書.md';
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(refDoc)}`);
    await saveDoc({
      path: refDoc,
      body: `![[${up.path}]]\n`,
      tags: [],
      baseUpdatedAt: got.json().updatedAt,
    });

    // 議事録フォルダを書き込み禁止にして、添付本体のrename(同フォルダ内)だけを
    // 確実に失敗させる(vi.spyOnではrename自体を差し替えられないため実FSで再現する)
    const folderAbs = join(lib, '議事録');
    await chmod(folderAbs, 0o500);
    try {
      const res = await api('POST', '/api/attachments/rename', {
        path: up.path,
        newName: 'ロールバック後.png',
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      // 後片付け(afterEachのrm成功のためにも書き込み権限を戻す)
      await chmod(folderAbs, 0o700);
    }

    const files = await readdir(folderAbs);
    expect(files).toContain(up.fileName);

    const bodyAfter = (await api('GET', `/api/docs?path=${encodeURIComponent(refDoc)}`)).json().body;
    expect(bodyAfter).toContain(`![[${up.path}]]`);
  }, 20_000);

  it('【中4】pathが配列(?path=a&path=b)だと400', async () => {
    const res = await api('DELETE', '/api/attachments?path=a.png&path=b.png');
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it('【中5】newNameが200文字を超えると400', async () => {
    const up = await uploadTo(docPath);
    const longName = `${'あ'.repeat(200)}.png`;
    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: longName });
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it('【中5】newNameがUTF-8で255byteを超えると400', async () => {
    const up = await uploadTo(docPath);
    // 3byte/文字の日本語で255byteを超えるが200文字以下に収まる長さにする
    const longName = `${'漢'.repeat(90)}.png`;
    expect(longName.length).toBeLessThanOrEqual(200);
    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: longName });
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it('【軽微8】前後に空白のあるtarget(![[ old.png ]])も書き換わる', async () => {
    const up = await uploadTo(docPath, '空白対象.png');
    await api('POST', '/api/docs', { folder: '議事録', title: '空白参照文書' });
    const spaceDoc = '議事録/空白参照文書.md';
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(spaceDoc)}`);
    await saveDoc({
      path: spaceDoc,
      body: `![[ ${up.fileName} ]]\n`,
      tags: [],
      baseUpdatedAt: got.json().updatedAt,
    });

    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: '空白後.png' });
    expect(res.statusCode).toBe(200);

    const after = (await api('GET', `/api/docs?path=${encodeURIComponent(spaceDoc)}`)).json().body;
    expect(after).toContain('![[空白後.png]]');
  }, 20_000);

  it('【軽微11】ロック中の文書でも参照は書き換わる(リンク整合を優先)', async () => {
    app.userService.create({ username: '鈴木', displayName: '鈴木', password: 'p', role: 'user' });
    const loginSuzuki = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: CSRF,
      payload: { username: '鈴木', password: 'p' },
    });
    const suzukiCookie = (loginSuzuki.headers['set-cookie'] as string).split(';')[0];
    const apiAsSuzuki = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
      app.inject({ method, url, headers: { ...CSRF, cookie: suzukiCookie }, payload: payload as never });

    const up = await uploadTo(docPath, 'ロック中対象.png');
    await api('POST', '/api/docs', { folder: '議事録', title: 'ロック中参照文書' });
    const lockedDoc = '議事録/ロック中参照文書.md';
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(lockedDoc)}`);
    await saveDoc({
      path: lockedDoc,
      body: `![[${up.fileName}]]\n`,
      tags: [],
      baseUpdatedAt: got.json().updatedAt,
    });

    // saveDocヘルパーが取得した自分(yamada)のロックを解放してから、鈴木がロックし直す
    await api('DELETE', `/api/locks?path=${encodeURIComponent(lockedDoc)}`);
    const lockRes = await apiAsSuzuki('POST', '/api/locks', { path: lockedDoc });
    expect(lockRes.statusCode).toBe(200);

    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: 'ロック後.png' });
    expect(res.statusCode).toBe(200);

    const after = (await api('GET', `/api/docs?path=${encodeURIComponent(lockedDoc)}`)).json().body;
    expect(after).toContain('![[ロック後.png]]');
  }, 20_000);

  it('【軽微11】.trash配下・.md・非対応拡張子(.txt)・トラバーサルはresolve/references/rename/deleteとも拒否される', async () => {
    // #204: .pdf は添付として扱うようになったため、非対応拡張子の代表は .txt に変更
    const cases = ['.trash/x.png', '議事録/添付先.md', 'x.txt', '../outside.png'];
    for (const p of cases) {
      const resolve = await api('GET', `/api/attachments/resolve?target=${encodeURIComponent(p)}`);
      expect([400, 404]).toContain(resolve.statusCode); // resolveは索引解決のためInvalidPath型ではなく未解決404もありうる

      const references = await api('GET', `/api/attachments/references?path=${encodeURIComponent(p)}`);
      expect(references.statusCode).toBe(400);

      const rename = await api('POST', '/api/attachments/rename', { path: p, newName: '変更後.png' });
      expect(rename.statusCode).toBe(400);

      const del = await api('DELETE', `/api/attachments?path=${encodeURIComponent(p)}`);
      expect(del.statusCode).toBe(400);
    }
  }, 20_000);

  it('【軽微11】拡張子省略で補完された名前が参照文書側にも反映される', async () => {
    const up = await uploadTo(docPath, '拡張子省略参照対象.png');
    await api('POST', '/api/docs', { folder: '議事録', title: '拡張子省略参照文書' });
    const extDoc = '議事録/拡張子省略参照文書.md';
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(extDoc)}`);
    await saveDoc({
      path: extDoc,
      body: `![[${up.fileName}]]\n`,
      tags: [],
      baseUpdatedAt: got.json().updatedAt,
    });

    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: '拡張子省略後' });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('拡張子省略後.png');

    const after = (await api('GET', `/api/docs?path=${encodeURIComponent(extDoc)}`)).json().body;
    expect(after).toContain('![[拡張子省略後.png]]');
  }, 20_000);

  it('rewrittenDocs[].replacementsに実際の置換元/置換先が入る(API契約)', async () => {
    const up = await uploadTo(docPath, '置換確認対象.png');
    await api('POST', '/api/docs', { folder: '議事録', title: '置換確認文書' });
    const repDoc = '議事録/置換確認文書.md';
    const got = await api('GET', `/api/docs?path=${encodeURIComponent(repDoc)}`);
    await saveDoc({
      path: repDoc,
      body: `![[ ${up.fileName} |300]]\n![説明](議事録/${up.fileName} "t")\n`,
      tags: [],
      baseUpdatedAt: got.json().updatedAt,
    });

    const res = await api('POST', '/api/attachments/rename', { path: up.path, newName: '置換確認後.png' });
    expect(res.statusCode).toBe(200);
    const entry = res.json().rewrittenDocs.find((d: { path: string }) => d.path === repDoc);
    expect(entry.replacements).toEqual(
      expect.arrayContaining([
        { from: up.fileName, to: '置換確認後.png' },
        { from: `議事録/${up.fileName}`, to: '議事録/置換確認後.png' },
      ]),
    );
    expect(entry.replacements).toHaveLength(2);
  }, 20_000);

  it('【中B】Markdown/Obsidian記法上の意味を持つ文字(#・]・(・)・`)を含む新名は400', async () => {
    const up = await uploadTo(docPath, '記法文字対象.png');
    for (const newName of ['a#b.png', 'a]b.png', 'a(b).png', 'a`b.png']) {
      const res = await api('POST', '/api/attachments/rename', { path: up.path, newName });
      expect(res.statusCode).toBe(400);
      // 利用者が原因を判断できる文言を返す(固定の「パスが不正です」ではない)
      expect(res.json().error.message).toContain('リンク記法');
    }
  }, 20_000);
});

describe('PDF添付(issue #204)', () => {
  const upload = (name: string, content: Buffer, target = docPath) => {
    const mp = multipart({}, { name, content });
    return app.inject({
      method: 'POST',
      url: `/api/attachments?docPath=${encodeURIComponent(target)}`,
      headers: { ...CSRF, cookie, ...mp.headers },
      payload: mp.payload,
    });
  };

  it('PDFアップロードが201で通り、元ファイル名を尊重した名前で保存される', async () => {
    const res = await upload('報告書.pdf', PDF);
    expect(res.statusCode).toBe(201);
    const { fileName, path: relPath } = res.json();
    expect(fileName).toBe('報告書.pdf');
    expect(relPath).toBe(`議事録/${fileName}`);

    const files = await readdir(join(lib, '議事録'));
    expect(files).toContain(fileName);
  }, 20_000);

  it('同名PDFを再アップロードすると連番サフィックスが付く', async () => {
    const first = await upload('重複.pdf', PDF);
    expect(first.json().fileName).toBe('重複.pdf');
    const second = await upload('重複.pdf', PDF);
    expect(second.json().fileName).toBe('重複-2.pdf');
  }, 20_000);

  it('Windows予約文字を含むファイル名は_に置換される', async () => {
    // multipartボディの生成が単純な文字列連結のため"(ダブルクォート)は使わない
    // (Content-Dispositionのfilename値の区切りと衝突するため)
    const res = await upload('a:b*c?d<e>f|g.pdf', PDF);
    expect(res.statusCode).toBe(201);
    expect(res.json().fileName).toBe('a_b_c_d_e_f_g.pdf');
  }, 20_000);

  it('パス区切りを含むファイル名はbasenameだけが使われる(ディレクトリ部分は無視)', async () => {
    const res = await upload('sub/dir/実際の名前.pdf', PDF);
    expect(res.statusCode).toBe(201);
    expect(res.json().fileName).toBe('実際の名前.pdf');
  }, 20_000);

  it('先頭ドットの元名は隠しファイル化せず fileName に反映される', async () => {
    // `.hidden.pdf` → `hidden.pdf`、`..pdf` / `...pdf` → `document.pdf`
    const r1 = await upload('.hidden.pdf', PDF);
    expect(r1.statusCode).toBe(201);
    expect(r1.json().fileName).toBe('hidden.pdf');

    const r2 = await upload('..pdf', PDF);
    expect(r2.statusCode).toBe(201);
    expect(r2.json().fileName).toBe('document.pdf');

    const r3 = await upload('...pdf', PDF);
    expect(r3.statusCode).toBe(201);
    // 'document.pdf' は既存(r2)なので連番になる
    expect(r3.json().fileName).toBe('document-2.pdf');
  }, 30_000);

  it('PDF配信のContent-Type/Content-Disposition/CSPが画像・SVGと異なる(緩いCSPでinline)', async () => {
    const up = await upload('配信確認.pdf', PDF);
    expect(up.statusCode).toBe(201);

    const res = await app.inject({
      method: 'GET',
      url: `/api/files/${up.json().path.split('/').map(encodeURIComponent).join('/')}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline');
    {
      const csp = parseCsp(res.headers['content-security-policy'] as string | undefined);
      // PDFはブラウザ内蔵PDFビューアが動くよう'self'を許可。ワイルドカードは絶対に混ぜない
      expect(csp['default-src']).toEqual(["'self'"]);
      expect(csp['script-src']).toEqual(["'self'"]);
      expect(csp['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
      expect(csp['img-src']).toEqual(["'self'", 'data:', 'blob:']);
      expect(csp['font-src']).toEqual(["'self'", 'data:']);
    }
    expect(res.rawPayload.equals(PDF)).toBe(true);
  }, 20_000);

  it('画像はPDFと異なり従来どおりdefault-src \'none\'のまま', async () => {
    const up = await upload('画像確認.png', PNG);
    const res = await app.inject({
      method: 'GET',
      url: `/api/files/${up.json().path.split('/').map(encodeURIComponent).join('/')}`,
      headers: { cookie },
    });
    {
      const csp = parseCsp(res.headers['content-security-policy'] as string | undefined);
      expect(csp['default-src']).toEqual(["'none'"]);
      expect(csp['script-src']).toBeUndefined();
    }
  }, 20_000);
});
