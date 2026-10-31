import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';

// Remote MCPエンドポイント(issue #190)のテスト

const TOKEN = 'a'.repeat(64);

type App = ReturnType<typeof buildApp>;
let app: App;
let lib: string;

async function buildMcpApp(overrides: Record<string, string | undefined> = {}): Promise<void> {
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-mcp-'));
  const config = loadConfig({
    LIBRARY_PATH: lib,
    MCP_ENABLED: 'true',
    MCP_TOKEN: TOKEN,
    ...overrides,
  });
  const db = openDatabase(':memory:');
  app = buildApp({ config, db, logger: false });
  await app.ready();
}

function mcpRequest(body: unknown, token = TOKEN) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: body as never,
  });
}

const INITIALIZE_PAYLOAD = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  },
};

afterEach(async () => {
  if (app) await app.close();
  if (lib) await rm(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('POST /mcp 認証', () => {
  beforeEach(async () => {
    await buildMcpApp();
  });

  it('Authorizationヘッダなしは401でWWW-Authenticateを返す', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: INITIALIZE_PAYLOAD,
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Bearer');
  });

  it('誤ったトークンは401でinvalid_tokenを返す', async () => {
    const res = await mcpRequest(INITIALIZE_PAYLOAD, 'wrong-token-wrong-token-wrong-token');
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('invalid_token');
  });

  it('スキームが小文字(bearer)や余分な空白でも認証できる', async () => {
    for (const scheme of ['bearer', 'Bearer']) {
      for (const sep of [' ', '  ']) {
        const res = await app.inject({
          method: 'POST',
          url: '/mcp',
          headers: {
            authorization: `${scheme}${sep}${TOKEN}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          payload: INITIALIZE_PAYLOAD,
        });
        expect(res.statusCode).toBe(200);
      }
    }
  });
});

describe('POST /mcp 認証(エンコードしたパス・他ルート)', () => {
  beforeEach(async () => {
    await buildMcpApp();
  });

  it('パーセントエンコードしたパス(/%6dcp, /m%63p)もAuthorizationなしは401', async () => {
    for (const url of ['/%6dcp', '/m%63p']) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: INITIALIZE_PAYLOAD,
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('/api/healthはAuthorizationなしでも従来どおり200', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /mcp JSON-RPC', () => {
  beforeEach(async () => {
    await buildMcpApp();
  });

  it('initializeでserverInfo.nameがtsumiwikiになる', async () => {
    const res = await mcpRequest(INITIALIZE_PAYLOAD);
    expect(res.statusCode).toBe(200);
    expect(res.json().result.serverInfo.name).toBe('tsumiwiki');
  });

  it('tools/listで期待する20個のツール名が全て含まれる', async () => {
    const res = await mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(res.statusCode).toBe(200);
    const names = res.json().result.tools.map((t: { name: string }) => t.name);
    const expected = [
      'search_notes',
      'read_note',
      'list_recent',
      'list_tags',
      'get_docs_by_tags',
      'get_tree',
      'create_note',
      'save_note',
      'move_note',
      'delete_note',
      'create_daily_note',
      'append_to_daily_note',
      'get_backlinks',
      'get_history',
      'get_history_content',
      'get_history_diff',
      'list_library_history',
      'update_frontmatter',
      'create_folder',
      'move_folder',
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
    expect(expected).toHaveLength(20);
    expect(names).toHaveLength(20);
  });

  it('search_notesを何もない状態で呼ぶと空配列が返る', async () => {
    const res = await mcpRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'search_notes', arguments: { query: 'hello' } },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.result.isError).toBeFalsy();
    expect(json.result.structuredContent).toEqual({ items: [] });
  });

  it('create_noteで作成し、read_noteで本文を取得できる', async () => {
    const createRes = await mcpRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: 'test.md', content: '# hello' } },
    });
    expect(createRes.statusCode).toBe(200);
    expect(createRes.json().result.isError).toBeFalsy();

    const readRes = await mcpRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'test.md' } },
    });
    expect(readRes.statusCode).toBe(200);
    const readJson = readRes.json();
    expect(readJson.result.isError).toBeFalsy();
    expect(readJson.result.structuredContent.body).toContain('# hello');
  });

  it('同じpathでcreate_noteを2回呼ぶと2回目はエラーになる', async () => {
    const args = { path: 'dup.md', content: 'first' };
    const first = await mcpRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'create_note', arguments: args },
    });
    expect(first.json().result.isError).toBeFalsy();

    const second = await mcpRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'create_note', arguments: args },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().result.isError).toBe(true);
  });

  it('create_noteはトラバーサル・保護パス・.trash配下・非.md拡張子を全て拒否する', async () => {
    const badPaths = ['../foo.md', '.git/x.md', '.trash/x.md', 'foo.txt'];
    for (const [i, path] of badPaths.entries()) {
      const res = await mcpRequest({
        jsonrpc: '2.0',
        id: 100 + i,
        method: 'tools/call',
        params: { name: 'create_note', arguments: { path, content: 'x' } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().result.isError).toBe(true);
    }
  });

  it('save_noteに古いbaseUpdatedAtを渡すと競合エラーになる', async () => {
    await mcpRequest({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: 'conflict.md', content: 'orig' } },
    });
    const res = await mcpRequest({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: { path: 'conflict.md', body: 'new', baseUpdatedAt: '2000-01-01T00:00:00.000Z' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.isError).toBe(true);
  });

  it('他ユーザーが編集ロック保持中はsave_note/delete_note/move_noteが全てエラーになる', async () => {
    await mcpRequest({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: 'locked.md', content: 'x' } },
    });
    const user = app.userService.create({
      username: 'yamada',
      displayName: '山田',
      password: 'p',
      role: 'user',
    });
    app.lockService.acquire('locked.md', user.id);

    const saveRes = await mcpRequest({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: { path: 'locked.md', body: 'y', baseUpdatedAt: '2000-01-01T00:00:00.000Z' },
      },
    });
    expect(saveRes.json().result.isError).toBe(true);

    const deleteRes = await mcpRequest({
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: 'delete_note', arguments: { path: 'locked.md' } },
    });
    expect(deleteRes.json().result.isError).toBe(true);

    const moveRes = await mcpRequest({
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: { name: 'move_note', arguments: { path: 'locked.md', newFolder: '', newTitle: 'locked2' } },
    });
    expect(moveRes.json().result.isError).toBe(true);
  });

  it('AT-1: 既存スカラーの更新でコメント・キー順・他キーを保持する', async () => {
    const content = [
      '---',
      '料金単価: 1000 # 円',
      '課金単位: 月',
      'tags:',
      '  - infra',
      'updated: 2026-01-01T00:00:00+09:00',
      '---',
      '',
      '# 本文',
    ].join('\n');
    await mcpRequest({
      jsonrpc: '2.0',
      id: 301,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: 'at1.md', content } },
    });
    const read = await mcpRequest({
      jsonrpc: '2.0',
      id: 302,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'at1.md' } },
    });
    const updatedAt = read.json().result.structuredContent.updatedAt;

    const saveRes = await mcpRequest({
      jsonrpc: '2.0',
      id: 303,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at1.md',
          body: '\n# 本文',
          baseUpdatedAt: updatedAt,
          frontmatter: { 料金単価: 1200 },
        },
      },
    });
    expect(saveRes.json().result.isError).toBeFalsy();
    const resContent = saveRes.json().result.structuredContent;
    expect(resContent.frontmatter.料金単価).toBe(1200);

    const raw = await readFile(join(lib, 'at1.md'), 'utf8');
    expect(raw).toContain('料金単価: 1200 # 円');
    expect(raw).toContain('課金単位: 月');
    expect(raw.indexOf('料金単価: 1200 # 円')).toBeLessThan(raw.indexOf('課金単位: 月'));
  });

  it('AT-2: 新しいキーを追加する(型の保持)', async () => {
    const content = '---\ntitle: A\n---\n\n本文';
    await mcpRequest({
      jsonrpc: '2.0',
      id: 311,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: 'at2.md', content } },
    });
    const read = await mcpRequest({
      jsonrpc: '2.0',
      id: 312,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'at2.md' } },
    });
    const updatedAt = read.json().result.structuredContent.updatedAt;

    const saveRes = await mcpRequest({
      jsonrpc: '2.0',
      id: 313,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at2.md',
          body: '\n本文',
          baseUpdatedAt: updatedAt,
          frontmatter: {
            次回更新日: '2026-12-01',
            自動更新: true,
            席数: 5,
            備考: '1000',
          },
        },
      },
    });
    expect(saveRes.json().result.isError).toBeFalsy();

    const raw = await readFile(join(lib, 'at2.md'), 'utf8');
    expect(raw).toContain('次回更新日: 2026-12-01');
    expect(raw).toContain('自動更新: true');
    expect(raw).toContain('席数: 5');
    expect(raw).toMatch(/備考: ["']1000["']/);
  });

  it('AT-3: null でキーを削除する', async () => {
    const content = '---\ntitle: A\n旧プラン: basic\n---\n\n本文';
    await mcpRequest({
      jsonrpc: '2.0',
      id: 321,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: 'at3.md', content } },
    });
    const read = await mcpRequest({
      jsonrpc: '2.0',
      id: 322,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'at3.md' } },
    });
    const updatedAt = read.json().result.structuredContent.updatedAt;

    const saveRes = await mcpRequest({
      jsonrpc: '2.0',
      id: 323,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at3.md',
          body: '\n本文',
          baseUpdatedAt: updatedAt,
          frontmatter: {
            旧プラン: null,
            存在しないキー: null,
          },
        },
      },
    });
    expect(saveRes.json().result.isError).toBeFalsy();
    const raw = await readFile(join(lib, 'at3.md'), 'utf8');
    expect(raw).not.toContain('旧プラン');
    expect(raw).toContain('title: A');
  });

  it('AT-4: 配列・オブジェクトは値ごと置換する', async () => {
    const content = '---\n連絡先:\n  mail: a@example.com\n  tel: "000"\n---\n\n本文';
    await mcpRequest({
      jsonrpc: '2.0',
      id: 331,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: 'at4.md', content } },
    });
    const read = await mcpRequest({
      jsonrpc: '2.0',
      id: 332,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'at4.md' } },
    });
    const updatedAt = read.json().result.structuredContent.updatedAt;

    const saveRes = await mcpRequest({
      jsonrpc: '2.0',
      id: 333,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at4.md',
          body: '\n本文',
          baseUpdatedAt: updatedAt,
          frontmatter: {
            連絡先: { mail: 'b@example.com' },
          },
        },
      },
    });
    expect(saveRes.json().result.isError).toBeFalsy();
    const raw = await readFile(join(lib, 'at4.md'), 'utf8');
    expect(raw).toContain('mail: b@example.com');
    expect(raw).not.toContain('tel');
  });

  it('AT-5: 予約キーを拒否する(tags, updated)', async () => {
    const content = '---\ntitle: A\n---\n\n本文';
    await mcpRequest({
      jsonrpc: '2.0',
      id: 341,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: 'at5.md', content } },
    });
    const read = await mcpRequest({
      jsonrpc: '2.0',
      id: 342,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'at5.md' } },
    });
    const updatedAt = read.json().result.structuredContent.updatedAt;

    const resTags = await mcpRequest({
      jsonrpc: '2.0',
      id: 343,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at5.md',
          body: '\n本文',
          baseUpdatedAt: updatedAt,
          frontmatter: { tags: ['x'] },
        },
      },
    });
    expect(resTags.json().result.isError).toBe(true);

    const resUpdated = await mcpRequest({
      jsonrpc: '2.0',
      id: 344,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at5.md',
          body: '\n本文',
          baseUpdatedAt: updatedAt,
          frontmatter: { updated: '2026-01-01' },
        },
      },
    });
    expect(resUpdated.json().result.isError).toBe(true);

    const raw = await readFile(join(lib, 'at5.md'), 'utf8');
    expect(raw.trim()).toBe(content.trim());
  });

  it('AT-6: 危険キー・空キーを拒否する', async () => {
    const content = '---\ntitle: A\n---\n\n本文';
    await mcpRequest({
      jsonrpc: '2.0',
      id: 351,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: 'at6.md', content } },
    });
    const read = await mcpRequest({
      jsonrpc: '2.0',
      id: 352,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'at6.md' } },
    });
    const updatedAt = read.json().result.structuredContent.updatedAt;

    // Fastify の secure-json-parse または MCP ハンドラにより __proto__ は 400 または isError で拒否される
    const resProto = await mcpRequest({
      jsonrpc: '2.0',
      id: 353,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at6.md',
          body: '\n本文',
          baseUpdatedAt: updatedAt,
          frontmatter: JSON.parse('{"__proto__": {"admin": true}}'),
        },
      },
    });
    const isProtoRejected = resProto.statusCode === 400 || resProto.json()?.result?.isError === true;
    expect(isProtoRejected).toBe(true);

    const resConstructor = await mcpRequest({
      jsonrpc: '2.0',
      id: 354,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at6.md',
          body: '\n本文',
          baseUpdatedAt: updatedAt,
          frontmatter: { constructor: 'evil' },
        },
      },
    });
    expect(resConstructor.json().result.isError).toBe(true);

    const resPrototype = await mcpRequest({
      jsonrpc: '2.0',
      id: 355,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at6.md',
          body: '\n本文',
          baseUpdatedAt: updatedAt,
          frontmatter: { prototype: 'evil' },
        },
      },
    });
    expect(resPrototype.json().result.isError).toBe(true);

    const resEmpty = await mcpRequest({
      jsonrpc: '2.0',
      id: 356,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at6.md',
          body: '\n本文',
          baseUpdatedAt: updatedAt,
          frontmatter: { '   ': 'val' },
        },
      },
    });
    expect(resEmpty.json().result.isError).toBe(true);

    // いずれの異常系でもファイル内容は不変
    const rawAfter = await readFile(join(lib, 'at6.md'), 'utf8');
    expect(rawAfter.trim()).toBe(content.trim());
  });

  it('AT-7: フロントマターの無い文書に FM を新規作成する', async () => {
    const content = '# タイトルのみ\n\n本文です';
    await mcpRequest({
      jsonrpc: '2.0',
      id: 361,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: 'at7.md', content } },
    });
    const read = await mcpRequest({
      jsonrpc: '2.0',
      id: 362,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'at7.md' } },
    });
    const updatedAt = read.json().result.structuredContent.updatedAt;

    // frontmatter/tags なし保存では FM は作られない
    const saveNoFm = await mcpRequest({
      jsonrpc: '2.0',
      id: 363,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at7.md',
          body: '# タイトルのみ\n\n更新後本文',
          baseUpdatedAt: updatedAt,
        },
      },
    });
    expect(saveNoFm.json().result.isError).toBeFalsy();
    let raw = await readFile(join(lib, 'at7.md'), 'utf8');
    expect(raw.startsWith('---')).toBe(false);

    const read2 = await mcpRequest({
      jsonrpc: '2.0',
      id: 364,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'at7.md' } },
    });
    const updatedAt2 = read2.json().result.structuredContent.updatedAt;

    // frontmatter / tags を渡すと新規 FM が作成される
    const saveFm = await mcpRequest({
      jsonrpc: '2.0',
      id: 365,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at7.md',
          body: '# タイトルのみ\n\n更新後本文',
          baseUpdatedAt: updatedAt2,
          frontmatter: { 料金単価: 500 },
          tags: ['契約'],
        },
      },
    });
    expect(saveFm.json().result.isError).toBeFalsy();
    raw = await readFile(join(lib, 'at7.md'), 'utf8');
    expect(raw.startsWith('---')).toBe(true);
    expect(raw).toContain('料金単価: 500');
    expect(raw).toContain('tags:');
    expect(raw).toContain('契約');
    expect(raw).toContain('updated:');
    expect(raw.indexOf('料金単価: 500')).toBeLessThan(raw.indexOf('tags:'));
    expect(raw.indexOf('tags:')).toBeLessThan(raw.indexOf('updated:'));
  });

  it('AT-8: 壊れた FM には書き込まずエラーにする', async () => {
    const content = '---\ntitle: [壊れたYAML\n---\n\n本文';
    await mcpRequest({
      jsonrpc: '2.0',
      id: 371,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: 'at8.md', content } },
    });
    const read = await mcpRequest({
      jsonrpc: '2.0',
      id: 372,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'at8.md' } },
    });
    const updatedAt = read.json().result.structuredContent.updatedAt;

    const saveRes = await mcpRequest({
      jsonrpc: '2.0',
      id: 373,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at8.md',
          body: '\n本文',
          baseUpdatedAt: updatedAt,
          frontmatter: { 料金単価: 500 },
        },
      },
    });
    expect(saveRes.json().result.isError).toBe(true);
    const raw = await readFile(join(lib, 'at8.md'), 'utf8');
    expect(raw.trim()).toBe(content.trim());
  });

  it('AT-9: body 先頭の YAML ヘッダーを抽出してマージする', async () => {
    const content = '---\ntitle: 元タイトル\n旧キー: old\n---\n\n本文';
    await mcpRequest({
      jsonrpc: '2.0',
      id: 381,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: 'at9.md', content } },
    });
    const read = await mcpRequest({
      jsonrpc: '2.0',
      id: 382,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'at9.md' } },
    });
    const updatedAt = read.json().result.structuredContent.updatedAt;

    const bodyWithHeader = [
      '---',
      'title: 新タイトル',
      'ヘッダーキー: from-body',
      'aliases:',
      'tags:',
      '  - from-header',
      '---',
      '',
      '# 純粋な本文',
    ].join('\n');

    const saveRes = await mcpRequest({
      jsonrpc: '2.0',
      id: 383,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at9.md',
          body: bodyWithHeader,
          baseUpdatedAt: updatedAt,
          frontmatter: { title: '引数タイトル' }, // 引数優先
        },
      },
    });
    expect(saveRes.json().result.isError).toBeFalsy();
    const raw = await readFile(join(lib, 'at9.md'), 'utf8');
    const matches = raw.match(/---/g);
    expect(matches).toHaveLength(2);
    expect(raw).toContain('title: 引数タイトル');
    expect(raw).toContain('ヘッダーキー: from-body');
    expect(raw).toContain('旧キー: old');
    expect(raw).toContain('aliases:');
    expect(raw).toContain('# 純粋な本文');

    // 戻り値の frontmatter にも aliases: null が保持されている
    const structured = saveRes.json().result.structuredContent;
    expect(structured.frontmatter).toBeDefined();
    expect(structured.frontmatter.title).toBe('引数タイトル');
    expect(structured.frontmatter.aliases).toBeNull();

    // 追加検証: 空値キー(備考:)を含む既存文書に本文のみを再保存しても空値キーが維持される
    const read2 = await mcpRequest({
      jsonrpc: '2.0',
      id: 384,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'at9.md' } },
    });
    const updatedAt2 = read2.json().result.structuredContent.updatedAt;

    const saveRes2 = await mcpRequest({
      jsonrpc: '2.0',
      id: 385,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at9.md',
          body: '---\n備考:\n---\n\n# さらに更新された本文',
          baseUpdatedAt: updatedAt2,
        },
      },
    });
    expect(saveRes2.json().result.isError).toBeFalsy();
    const raw2 = await readFile(join(lib, 'at9.md'), 'utf8');
    expect(raw2).toContain('aliases:');
    expect(raw2).toContain('備考:');
    expect(raw2).toContain('# さらに更新された本文');
  });

  it('AT-10: 本文が水平線で始まるだけなら抽出しない', async () => {
    const content = '---\ntitle: 元ノート\n---\n\n初期本文';
    await mcpRequest({
      jsonrpc: '2.0',
      id: 391,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: 'at10.md', content } },
    });
    const read = await mcpRequest({
      jsonrpc: '2.0',
      id: 392,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'at10.md' } },
    });
    const updatedAt = read.json().result.structuredContent.updatedAt;

    const bodyHorizontalRule = '---\n\nただの文章\n\n---';
    const saveRes = await mcpRequest({
      jsonrpc: '2.0',
      id: 393,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at10.md',
          body: bodyHorizontalRule,
          baseUpdatedAt: updatedAt,
        },
      },
    });
    expect(saveRes.json().result.isError).toBeFalsy();
    const raw = await readFile(join(lib, 'at10.md'), 'utf8');
    expect(raw).toContain('---\n\nただの文章\n\n---');
  });

  it('AT-11: frontmatter 省略時は既存挙動と同じ(回帰検証)', async () => {
    const content = '---\ntitle: A\ntags:\n  - old\n---\n\n本文';
    await mcpRequest({
      jsonrpc: '2.0',
      id: 401,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: 'at11.md', content } },
    });
    const read = await mcpRequest({
      jsonrpc: '2.0',
      id: 402,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'at11.md' } },
    });
    const updatedAt = read.json().result.structuredContent.updatedAt;

    const saveRes = await mcpRequest({
      jsonrpc: '2.0',
      id: 403,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at11.md',
          body: '\n更新本文',
          baseUpdatedAt: updatedAt,
          tags: ['new-tag'],
        },
      },
    });
    expect(saveRes.json().result.isError).toBeFalsy();
    const raw = await readFile(join(lib, 'at11.md'), 'utf8');
    expect(raw).toContain('title: A');
    expect(raw).toContain('new-tag');
    expect(raw).not.toContain('old');
    expect(raw).toContain('更新本文');
  });

  it('AT-12: 競合検知とロック検査が frontmatter 付きでも先に効く', async () => {
    const content = '---\ntitle: A\n---\n\n本文';
    await mcpRequest({
      jsonrpc: '2.0',
      id: 411,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: 'at12.md', content } },
    });

    // 競合検知: frontmatter に予約キー(tags)が含まれていても、frontmatter 検証より前に競合検知が先行する
    const conflictRes = await mcpRequest({
      jsonrpc: '2.0',
      id: 412,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at12.md',
          body: 'new',
          baseUpdatedAt: '2000-01-01T00:00:00.000Z',
          frontmatter: { tags: ['x'] },
        },
      },
    });
    expect(conflictRes.json().result.isError).toBe(true);
    expect(conflictRes.json().result.content[0].text).toContain('変更されています');
    const rawAfterConflict = await readFile(join(lib, 'at12.md'), 'utf8');
    expect(rawAfterConflict.trim()).toBe(content.trim());

    // ロック検査: 他者がロック中の場合は保存拒否される
    const read = await mcpRequest({
      jsonrpc: '2.0',
      id: 413,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'at12.md' } },
    });
    const updatedAt = read.json().result.structuredContent.updatedAt;

    const user = app.userService.create({
      username: 'yamada2',
      displayName: '山田2',
      password: 'p',
      role: 'user',
    });
    app.lockService.acquire('at12.md', user.id);

    const lockRes = await mcpRequest({
      jsonrpc: '2.0',
      id: 414,
      method: 'tools/call',
      params: {
        name: 'save_note',
        arguments: {
          path: 'at12.md',
          body: 'new',
          baseUpdatedAt: updatedAt,
          frontmatter: { 料金単価: 500 },
        },
      },
    });
    expect(lockRes.json().result.isError).toBe(true);
    const rawAfterLock = await readFile(join(lib, 'at12.md'), 'utf8');
    expect(rawAfterLock.trim()).toBe(content.trim());
  });

  it('AT-13: tools/list の save_note スキーマに frontmatter が存在する', async () => {
    const res = await mcpRequest({ jsonrpc: '2.0', id: 421, method: 'tools/list', params: {} });
    expect(res.statusCode).toBe(200);
    const saveNoteTool = res
      .json()
      .result.tools.find((t: { name: string }) => t.name === 'save_note');
    expect(saveNoteTool).toBeDefined();
    expect(saveNoteTool.inputSchema.properties.frontmatter).toBeDefined();
    expect(saveNoteTool.inputSchema.properties.frontmatter.type).toBe('object');
  });
});

describe('append_to_daily_note', () => {
  // 日付と時刻を固定する(Date だけを偽装し、タイマー類は本物のまま)
  const NOW = new Date(2026, 6, 5, 14, 30, 0);
  const NOTE = '日記/2026-07-05.md';
  let seq = 100;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    await buildMcpApp();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function callTool(name: string, args: Record<string, unknown>) {
    const res = await mcpRequest({
      jsonrpc: '2.0',
      id: seq++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    expect(res.statusCode).toBe(200);
    return res.json().result;
  }

  const rawNote = () => readFile(join(lib, NOTE), 'utf8');
  // 保存時にサーバーが付け替える updated 行は比較から除く
  const withoutUpdated = (raw: string) =>
    raw
      .split('\n')
      .filter((l) => !l.startsWith('updated:'))
      .join('\n');

  it('デイリーノートが無い状態で呼ぶと作成され、## メモ と entry が入る', async () => {
    const result = await callTool('append_to_daily_note', {
      text: '作業完了',
      source: 'Claude Code',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.path).toBe(NOTE);
    expect(result.structuredContent.created).toBe(true);
    expect(typeof result.structuredContent.updatedAt).toBe('string');
    const raw = await rawNote();
    expect(raw).toContain('# 2026-07-05\n\n## メモ\n\n14:30 [Claude Code] 作業完了\n');
  });

  it('既存ノートの ## メモ 節の末尾に入り、他の行は変わらない', async () => {
    const original =
      '---\ndate: 2026-07-05\n---\n\n# 2026-07-05\n\n## タスク\n\n- [ ] 朝会\n\n## メモ\n\n- 既存1\n- 既存2\n\n## 振り返り\n\n特になし\n';
    await callTool('create_note', { path: NOTE, content: original });

    const result = await callTool('append_to_daily_note', { text: '追記です', source: 'A' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.created).toBe(false);

    const expected =
      '---\ndate: 2026-07-05\n---\n\n# 2026-07-05\n\n## タスク\n\n- [ ] 朝会\n\n## メモ\n\n- 既存1\n- 既存2\n\n14:30 [A] 追記です\n\n## 振り返り\n\n特になし\n';
    expect(withoutUpdated(await rawNote())).toBe(expected);
  });

  it('見出しがないノートでは末尾に見出しごと入る', async () => {
    await callTool('create_note', {
      path: NOTE,
      content: '---\ndate: 2026-07-05\n---\n\n# 2026-07-05\n\n## タスク\n\n- [ ] 朝会\n',
    });
    await callTool('append_to_daily_note', { text: '追記です' });
    expect(withoutUpdated(await rawNote())).toBe(
      '---\ndate: 2026-07-05\n---\n\n# 2026-07-05\n\n## タスク\n\n- [ ] 朝会\n\n## メモ\n\n14:30 追記です\n',
    );
  });

  it('heading を指定するとその節に入る', async () => {
    await callTool('create_note', {
      path: NOTE,
      content: '# 2026-07-05\n\n## 作業ログ\n\n- a\n\n## メモ\n\nb\n',
    });
    await callTool('append_to_daily_note', { text: 'c', heading: '## 作業ログ' });
    expect(await rawNote()).toBe('# 2026-07-05\n\n## 作業ログ\n\n- a\n\n14:30 c\n\n## メモ\n\nb\n');
  });

  it('複数行の text は1行目だけに接頭辞が付く', async () => {
    await callTool('append_to_daily_note', { text: '1行目\n  2行目\n3行目\n', source: 'A' });
    expect(await rawNote()).toContain('## メモ\n\n14:30 [A] 1行目\n  2行目\n3行目\n');
  });

  it('他ユーザーが編集ロック中なら DOC_LOCKED の isError になり、本文は変わらない', async () => {
    await callTool('create_daily_note', {});
    const before = await rawNote();
    const user = app.userService.create({
      username: 'yamada',
      displayName: '山田',
      password: 'p',
      role: 'user',
    });
    app.lockService.acquire(NOTE, user.id);

    const result = await callTool('append_to_daily_note', { text: '追記です' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe('DOC_LOCKED');
    expect(result.structuredContent.holder).toEqual({ displayName: '山田' });
    expect(result.structuredContent.message).toContain('山田');
    expect(await rawNote()).toBe(before);
  });

  it('存在確認の直後にロックが取られても DOC_LOCKED になる', async () => {
    await callTool('create_daily_note', {});
    const user = app.userService.create({
      username: 'yamada',
      displayName: '山田',
      password: 'p',
      role: 'user',
    });
    const original = app.docService.getDoc.bind(app.docService);
    vi.spyOn(app.docService, 'getDoc').mockImplementation(async (p: string) => {
      const doc = await original(p);
      app.lockService.acquire(NOTE, user.id);
      return doc;
    });

    const result = await callTool('append_to_daily_note', { text: '追記です' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe('DOC_LOCKED');
  });

  it('2回続けて呼ぶと2件とも残り、呼んだ順に並ぶ', async () => {
    await callTool('append_to_daily_note', { text: '1件目' });
    vi.setSystemTime(new Date(2026, 6, 5, 14, 45, 0));
    await callTool('append_to_daily_note', { text: '2件目' });
    const raw = await rawNote();
    expect(raw).toContain('## メモ\n\n14:30 1件目\n\n14:45 2件目\n');
  });

  it('同時に6回呼んでも6件すべて残る', async () => {
    await callTool('create_daily_note', {});
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => callTool('append_to_daily_note', { text: `c${n}`, source: 'S' })),
    );
    for (const r of results) expect(r.isError).toBeFalsy();
    const raw = await rawNote();
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(raw.match(new RegExp(`^14:30 \\[S\\] c${n}$`, 'gm'))).toHaveLength(1);
    }
  });

  it('閉じのない --- で始まる文書でも先頭の --- と既存の本文が残る', async () => {
    await callTool('create_note', { path: NOTE, content: '---\n\n## メモ\n\na\n' });
    await callTool('append_to_daily_note', { text: '追記', source: 'S' });
    expect(await rawNote()).toBe('---\n\n## メモ\n\na\n\n14:30 [S] 追記\n');
  });

  it('... で閉じたフロントマターは二重にならず、本文もそのまま残る', async () => {
    await callTool('create_note', {
      path: NOTE,
      content: '---\ndate: 2026-07-05\n...\n\n## メモ\n\na\n',
    });
    await callTool('append_to_daily_note', { text: '追記', source: 'S' });
    const raw = await rawNote();
    expect(raw.match(/date: 2026-07-05/g)).toHaveLength(1);
    expect(raw.match(/^## メモ$/gm)).toHaveLength(1);
    expect(raw.endsWith('\n## メモ\n\na\n\n14:30 [S] 追記\n')).toBe(true);
    const read = await callTool('read_note', { path: NOTE });
    expect(String(read.structuredContent.frontmatter.date)).toContain('2026-07-05');
  });

  it('--- / # 見出し / --- で始まる文書でも見出しが重複・欠落せず追記される', async () => {
    await callTool('create_note', {
      path: NOTE,
      content: '---\n# 見出し\n---\n\n## メモ\n\na\n',
    });
    const result = await callTool('append_to_daily_note', { text: '追記', source: 'S' });
    expect(result.isError).toBeFalsy();
    const raw = await rawNote();
    expect(raw.match(/# 見出し/g)).toHaveLength(1);
    expect(raw.endsWith('\n## メモ\n\na\n\n14:30 [S] 追記\n')).toBe(true);
  });

  it('空のフロントマター(--- / ---)で始まる文書の本文が消えない', async () => {
    await callTool('create_note', { path: NOTE, content: '---\n---\n## メモ\n\na\n' });
    await callTool('append_to_daily_note', { text: '追記', source: 'S' });
    expect(await rawNote()).toBe('---\n---\n## メモ\n\na\n\n14:30 [S] 追記\n');
  });

  it('箇条書きの text は直前のリストに続き、段落の text は空行で区切られる', async () => {
    await callTool('create_note', { path: NOTE, content: '## メモ\n\n- 既存\n' });
    await callTool('append_to_daily_note', { text: '- 項目', source: 'S' });
    await callTool('append_to_daily_note', { text: '- [ ] 確認', source: 'S' });
    await callTool('append_to_daily_note', { text: '段落', source: 'S' });
    expect(await rawNote()).toBe(
      '## メモ\n\n- 既存\n- 14:30 [S] 項目\n- [ ] 14:30 [S] 確認\n\n14:30 [S] 段落\n',
    );
  });

  it('フロントマター(date など)がそのまま残る', async () => {
    await callTool('create_note', {
      path: NOTE,
      content: '---\ndate: 2026-07-05\n# 手書きコメント\nmood: good\n---\n\n# 2026-07-05\n',
    });
    await callTool('append_to_daily_note', { text: '追記です' });
    const raw = await rawNote();
    expect(raw.startsWith('---\ndate: 2026-07-05\n# 手書きコメント\nmood: good\n')).toBe(true);
    expect(raw.match(/^---$/gm)).toHaveLength(2);
    const read = await callTool('read_note', { path: NOTE });
    expect(read.structuredContent.frontmatter.mood).toBe('good');
  });

  it('本文が水平線とYAML風の行で始まっていてもフロントマターとして誤抽出されない', async () => {
    const original = '---\ndate: 2026-07-05\n---\n---\nnote: これは本文\n---\n\n## メモ\n\nx\n';
    await callTool('create_note', { path: NOTE, content: original });
    await callTool('append_to_daily_note', { text: '追記です' });
    expect(withoutUpdated(await rawNote())).toBe(
      '---\ndate: 2026-07-05\n---\n---\nnote: これは本文\n---\n\n## メモ\n\nx\n\n14:30 追記です\n',
    );
  });

  it('text が空白だけ・source に改行・heading が不正な場合はエラーになる', async () => {
    expect((await callTool('append_to_daily_note', { text: '  \n ' })).isError).toBe(true);
    expect((await callTool('append_to_daily_note', { text: 'a', source: 'x\ny' })).isError).toBe(true);
    const bad = await callTool('append_to_daily_note', { text: 'a', heading: 'メモ' });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.code).toBe('INVALID_HEADING');
  });

  it('create_daily_note は共通処理経由でも従来どおり作成・既存返却する', async () => {
    const first = await callTool('create_daily_note', {});
    expect(first.structuredContent).toEqual({ path: NOTE, created: true });
    const second = await callTool('create_daily_note', {});
    expect(second.structuredContent).toEqual({ path: NOTE, created: false });
  });
});

describe('create_daily_note の日付指定', () => {
  let seq = 400;
  beforeEach(async () => {
    await buildMcpApp();
  });

  async function callTool(name: string, args: Record<string, unknown>) {
    const res = await mcpRequest({
      jsonrpc: '2.0',
      id: seq++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    expect(res.statusCode).toBe(200);
    return res.json().result;
  }

  it('date 指定でその日のノートを作成し、同じ date で再実行すると created:false', async () => {
    const first = await callTool('create_daily_note', { date: '2026-03-09' });
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toEqual({ path: '日記/2026-03-09.md', created: true });
    const raw = await readFile(join(lib, '日記/2026-03-09.md'), 'utf8');
    expect(raw).toContain('date: 2026-03-09');
    const second = await callTool('create_daily_note', { date: '2026-03-09' });
    expect(second.structuredContent).toEqual({ path: '日記/2026-03-09.md', created: false });
  });

  it('実在しない日付・形式不正は INVALID_DATE', async () => {
    for (const bad of ['2026-02-30', 'abc', '2026-13-01', '2026-3-9']) {
      const r = await callTool('create_daily_note', { date: bad });
      expect(r.isError).toBe(true);
      expect(r.structuredContent.code).toBe('INVALID_DATE');
    }
  });

  it('date 省略は今日のノートを作る(従来どおり)', async () => {
    const r = await callTool('create_daily_note', {});
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.path).toMatch(/^日記\/\d{4}-\d{2}-\d{2}\.md$/);
  });
});

describe('フォルダ・バックリンク・履歴ツール', () => {
  let seq = 500;
  beforeEach(async () => {
    await buildMcpApp();
  });

  async function callTool(name: string, args: Record<string, unknown>) {
    const res = await mcpRequest({
      jsonrpc: '2.0',
      id: seq++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    expect(res.statusCode).toBe(200);
    return res.json().result;
  }

  function lockAsOtherUser(docPath: string) {
    const user = app.userService.create({
      username: 'yamada',
      displayName: '山田',
      password: 'p',
      role: 'user',
    });
    app.lockService.acquire(docPath, user.id);
  }

  it('create_folder で作ったフォルダが get_tree に出る', async () => {
    const r = await callTool('create_folder', { path: '議事録/2026' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ ok: true, path: '議事録/2026' });
    const tree = await callTool('get_tree', {});
    expect(tree.structuredContent.folders).toContain('議事録/2026');
  });

  it('create_folder は不正パスを拒否する', async () => {
    const r = await callTool('create_folder', { path: '../x' });
    expect(r.isError).toBe(true);
  });

  it('move_folder で改名すると配下のノートが新パスで読める', async () => {
    await callTool('create_note', { path: '議事録/2026/a.md', content: '# a' });
    const r = await callTool('move_folder', { path: '議事録/2026', newPath: '議事録/2026年度' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ path: '議事録/2026年度' });
    const read = await callTool('read_note', { path: '議事録/2026年度/a.md' });
    expect(read.isError).toBeFalsy();
    expect(read.structuredContent.body).toContain('# a');
    const old = await callTool('read_note', { path: '議事録/2026/a.md' });
    expect(old.isError).toBe(true);
  }, 20_000);

  it('配下のノートを他ユーザーがロック中なら move_folder はエラー', async () => {
    await callTool('create_note', { path: 'dir/a.md', content: 'x' });
    lockAsOtherUser('dir/a.md');
    const r = await callTool('move_folder', { path: 'dir', newPath: 'dir2' });
    expect(r.isError).toBe(true);
    const read = await callTool('read_note', { path: 'dir/a.md' });
    expect(read.isError).toBeFalsy();
  });

  it('自分の配下への move_folder はエラー', async () => {
    await callTool('create_note', { path: 'dir/a.md', content: 'x' });
    const r = await callTool('move_folder', { path: 'dir', newPath: 'dir/sub' });
    expect(r.isError).toBe(true);
  });

  it('get_backlinks はリンク元ノートを返し、limit も受け付ける', async () => {
    await callTool('create_note', { path: 'B.md', content: '# B' });
    await callTool('create_note', { path: 'A.md', content: '[[B]] を参照\n' });
    const r = await callTool('get_backlinks', { path: 'B.md' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.truncated).toBe(false);
    expect(r.structuredContent.backlinks).toHaveLength(1);
    expect(r.structuredContent.backlinks[0].sourcePath).toBe('A.md');
    const limited = await callTool('get_backlinks', { path: 'B.md', limit: 1 });
    expect(limited.structuredContent.backlinks).toHaveLength(1);
  }, 20_000);

  it('get_backlinks は存在しないノートでエラー', async () => {
    const r = await callTool('get_backlinks', { path: 'none.md' });
    expect(r.isError).toBe(true);
  });

  it('履歴ツール一式: 履歴・過去版・差分・全体履歴が取れ、不正 rev はエラー', async () => {
    await callTool('create_note', { path: 'h.md', content: '第1版' });
    const doc = await callTool('read_note', { path: 'h.md' });
    const saved = await callTool('save_note', {
      path: 'h.md',
      body: '第2版',
      baseUpdatedAt: doc.structuredContent.updatedAt,
    });
    expect(saved.isError).toBeFalsy();

    const hist = await callTool('get_history', { path: 'h.md' });
    const history = hist.structuredContent.history;
    expect(history.length).toBeGreaterThanOrEqual(2);
    const oldRev = history[history.length - 1].rev;

    const content = await callTool('get_history_content', { path: 'h.md', rev: oldRev });
    expect(content.structuredContent.content).toContain('第1版');

    const diff = await callTool('get_history_diff', { path: 'h.md', rev: oldRev });
    expect(diff.structuredContent.diff).toContain('-第1版');
    expect(diff.structuredContent.diff).toContain('+第2版');

    const all = await callTool('list_library_history', { limit: 10 });
    expect(all.structuredContent.history.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(all.structuredContent.history)).toContain('h.md');

    for (const [name, args] of [
      ['get_history_content', { path: 'h.md', rev: 'zz' }],
      ['get_history_diff', { path: 'h.md', rev: oldRev, against: 'zz' }],
    ] as const) {
      const bad = await callTool(name, args);
      expect(bad.isError).toBe(true);
    }
    const badLimit = await callTool('list_library_history', { limit: 0 });
    expect(badLimit.isError).toBe(true);
  }, 30_000);
});

describe('update_frontmatter', () => {
  const NOW = new Date(2026, 6, 5, 14, 30, 0);
  const NOTE = '日記/2026-07-05.md';
  let seq = 700;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    await buildMcpApp();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function callTool(name: string, args: Record<string, unknown>) {
    const res = await mcpRequest({
      jsonrpc: '2.0',
      id: seq++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    expect(res.statusCode).toBe(200);
    return res.json().result;
  }

  const readBody = async (p: string) =>
    (await callTool('read_note', { path: p })).structuredContent;

  it('プロパティの追加・削除で本文が1バイトも変わらない', async () => {
    const body = '# タイトル\n\n本文  \n\n- a\n末尾あり\n';
    await callTool('create_note', { path: 'p.md', content: `---\nstatus: draft\n---\n${body}` });
    const before = await readBody('p.md');

    const r = await callTool('update_frontmatter', {
      path: 'p.md',
      frontmatter: { status: 'done', owner: '山田' },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.frontmatter.status).toBe('done');
    expect(r.structuredContent.frontmatter.owner).toBe('山田');
    expect(typeof r.structuredContent.updatedAt).toBe('string');

    const after = await readBody('p.md');
    expect(after.body).toBe(before.body);
    const raw = await readFile(join(lib, 'p.md'), 'utf8');
    expect(raw.endsWith(body)).toBe(true);

    const removed = await callTool('update_frontmatter', {
      path: 'p.md',
      frontmatter: { owner: null },
    });
    expect(removed.structuredContent.frontmatter.owner).toBeUndefined();
  });

  it('フロントマターの無いノートにも追加できる', async () => {
    await callTool('create_note', { path: 'n.md', content: '本文のみ\n' });
    const r = await callTool('update_frontmatter', { path: 'n.md', frontmatter: { k: 1 } });
    expect(r.isError).toBeFalsy();
    // フロントマター新設時は、フェンスと本文の間に空行が1行入る(save_note と同じ)
    expect((await readBody('n.md')).body).toBe('\n本文のみ\n');
  });

  it('addTags / removeTags が効く', async () => {
    await callTool('create_note', { path: 't.md', content: '---\ntags:\n  - a\n  - b\n---\n本文\n' });
    const r = await callTool('update_frontmatter', {
      path: 't.md',
      addTags: ['c', '#a', ' d '],
      removeTags: ['b'],
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.tags).toEqual(['a', 'c', 'd']);
    expect((await readBody('t.md')).tags).toEqual(['a', 'c', 'd']);
  });

  it('既存 tags が文字列1個でも addTags / removeTags が効く', async () => {
    await callTool('create_note', { path: 's.md', content: '---\ntags: solo\n---\n本文\n' });
    const added = await callTool('update_frontmatter', { path: 's.md', addTags: ['x'] });
    expect(added.structuredContent.tags).toEqual(['solo', 'x']);
    const removed = await callTool('update_frontmatter', { path: 's.md', removeTags: ['solo'] });
    expect(removed.structuredContent.tags).toEqual(['x']);
  });

  it('tags は全置き換えで、空配列でタグを全削除できる', async () => {
    await callTool('create_note', { path: 'r.md', content: '---\ntags: [a, b]\n---\n本文\n' });
    const r = await callTool('update_frontmatter', { path: 'r.md', tags: ['z'] });
    expect(r.structuredContent.tags).toEqual(['z']);
    const cleared = await callTool('update_frontmatter', { path: 'r.md', tags: [] });
    expect(cleared.structuredContent.tags).toEqual([]);
  });

  it('インライン #タグは変更されない', async () => {
    await callTool('create_note', { path: 'i.md', content: '---\ntags: [a]\n---\n本文 #inline\n' });
    await callTool('update_frontmatter', { path: 'i.md', removeTags: ['inline', 'a'] });
    expect((await readBody('i.md')).body).toBe('本文 #inline\n');
  });

  it('tags と addTags の同時指定は INVALID_ARGUMENTS、何も指定しないと NOTHING_TO_UPDATE', async () => {
    await callTool('create_note', { path: 'e.md', content: '本文' });
    const both = await callTool('update_frontmatter', { path: 'e.md', tags: ['a'], addTags: ['b'] });
    expect(both.isError).toBe(true);
    expect(both.structuredContent.code).toBe('INVALID_ARGUMENTS');
    const bothRemove = await callTool('update_frontmatter', {
      path: 'e.md',
      tags: ['a'],
      removeTags: ['b'],
    });
    expect(bothRemove.structuredContent.code).toBe('INVALID_ARGUMENTS');
    const none = await callTool('update_frontmatter', { path: 'e.md' });
    expect(none.isError).toBe(true);
    expect(none.structuredContent.code).toBe('NOTHING_TO_UPDATE');
  });

  it('予約キー(tags / updated)を frontmatter に渡すとエラー', async () => {
    await callTool('create_note', { path: 'k.md', content: '本文' });
    const r = await callTool('update_frontmatter', { path: 'k.md', frontmatter: { updated: 'x' } });
    expect(r.isError).toBe(true);
  });

  it('古い baseUpdatedAt は競合エラー、正しい値なら成功、省略しても成功', async () => {
    await callTool('create_note', { path: 'c.md', content: '本文' });
    const stale = await callTool('update_frontmatter', {
      path: 'c.md',
      frontmatter: { a: 1 },
      baseUpdatedAt: '2000-01-01T00:00:00.000Z',
    });
    expect(stale.isError).toBe(true);
    const current = (await readBody('c.md')).updatedAt;
    const ok = await callTool('update_frontmatter', {
      path: 'c.md',
      frontmatter: { a: 1 },
      baseUpdatedAt: current,
    });
    expect(ok.isError).toBeFalsy();
    const omitted = await callTool('update_frontmatter', { path: 'c.md', frontmatter: { a: 2 } });
    expect(omitted.isError).toBeFalsy();
  });

  it('他ユーザーが編集ロック中なら DOC_LOCKED で、ファイルは変わらない', async () => {
    await callTool('create_note', { path: 'l.md', content: '本文' });
    const before = await readFile(join(lib, 'l.md'), 'utf8');
    const user = app.userService.create({
      username: 'yamada',
      displayName: '山田',
      password: 'p',
      role: 'user',
    });
    app.lockService.acquire('l.md', user.id);
    const r = await callTool('update_frontmatter', { path: 'l.md', frontmatter: { a: 1 } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.code).toBe('DOC_LOCKED');
    expect(r.structuredContent.holder).toEqual({ displayName: '山田' });
    expect(await readFile(join(lib, 'l.md'), 'utf8')).toBe(before);
  });

  it('存在しないノートはエラー', async () => {
    const r = await callTool('update_frontmatter', { path: 'none.md', frontmatter: { a: 1 } });
    expect(r.isError).toBe(true);
  });

  it('append_to_daily_note と同時に呼んでも両方の変更が残る', async () => {
    await callTool('create_daily_note', {});
    const results = await Promise.all([
      callTool('append_to_daily_note', { text: '追記A', source: 'S' }),
      callTool('update_frontmatter', { path: NOTE, frontmatter: { mood: 'good' }, addTags: ['t1'] }),
      callTool('append_to_daily_note', { text: '追記B', source: 'S' }),
      callTool('update_frontmatter', { path: NOTE, frontmatter: { weather: 'sunny' }, addTags: ['t2'] }),
    ]);
    for (const r of results) expect(r.isError).toBeFalsy();
    const raw = await readFile(join(lib, NOTE), 'utf8');
    expect(raw).toContain('追記A');
    expect(raw).toContain('追記B');
    const note = await readBody(NOTE);
    expect(note.frontmatter.mood).toBe('good');
    expect(note.frontmatter.weather).toBe('sunny');
    expect(note.tags).toEqual(expect.arrayContaining(['t1', 't2']));
  });
});

describe('MCP_ENABLED=false', () => {
  it('POST /mcpは404になる(登録されていない)', async () => {
    lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-mcp-off-'));
    const config = loadConfig({ LIBRARY_PATH: lib });
    const db = openDatabase(':memory:');
    app = buildApp({ config, db, logger: false });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: INITIALIZE_PAYLOAD,
    });
    expect(res.statusCode).toBe(404);
  });

  it('staticRoot設定ありでもPOST /mcpはSPAフォールバックせずJSON 404を返す', async () => {
    lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-mcp-static-'));
    const staticDir = await mkdtemp(join(tmpdir(), 'tsumiwiki-mcp-static-root-'));
    try {
      await writeFile(join(staticDir, 'index.html'), '<html><body>SPA</body></html>', 'utf8');
      const config = loadConfig({ LIBRARY_PATH: lib, STATIC_ROOT: staticDir });
      const db = openDatabase(':memory:');
      app = buildApp({ config, db, logger: false });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: INITIALIZE_PAYLOAD,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    } finally {
      await rm(staticDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('loadConfigのfail-secure検証', () => {
  it('MCP_ENABLED=trueかつMCP_TOKEN未設定はthrow', async () => {
    const tmpLib = await mkdtemp(join(tmpdir(), 'tsumiwiki-mcp-cfg-'));
    try {
      expect(() => loadConfig({ LIBRARY_PATH: tmpLib, MCP_ENABLED: 'true' })).toThrow();
    } finally {
      await rm(tmpLib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('MCP_ENABLED=trueかつMCP_TOKENが環境に無い(undefined)場合もthrow', async () => {
    const tmpLib = await mkdtemp(join(tmpdir(), 'tsumiwiki-mcp-cfg-'));
    try {
      expect(() =>
        loadConfig({ LIBRARY_PATH: tmpLib, MCP_ENABLED: 'true', MCP_TOKEN: undefined }),
      ).toThrow();
    } finally {
      await rm(tmpLib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('MCP_TOKENが31文字はthrow', async () => {
    const tmpLib = await mkdtemp(join(tmpdir(), 'tsumiwiki-mcp-cfg-'));
    try {
      expect(() =>
        loadConfig({ LIBRARY_PATH: tmpLib, MCP_ENABLED: 'true', MCP_TOKEN: 'a'.repeat(31) }),
      ).toThrow();
    } finally {
      await rm(tmpLib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('loadConfig: MCP_AUTH', () => {
  async function withLib(fn: (lib: string) => void): Promise<void> {
    const tmpLib = await mkdtemp(join(tmpdir(), 'tsumiwiki-mcp-cfg-'));
    try {
      fn(tmpLib);
    } finally {
      await rm(tmpLib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  it('MCP_AUTH=noneならMCP_TOKENなしでもthrowしない', async () => {
    await withLib((tmpLib) => {
      const config = loadConfig({ LIBRARY_PATH: tmpLib, MCP_ENABLED: 'true', MCP_AUTH: 'none' });
      expect(config.mcpAuth).toBe('none');
      expect(config.mcpToken).toBeNull();
      expect(config.mcpTokenIgnored).toBe(false);
    });
  });

  it('MCP_AUTH=noneでMCP_TOKENが短くてもthrowせず、無視された旨を保持する', async () => {
    await withLib((tmpLib) => {
      const config = loadConfig({
        LIBRARY_PATH: tmpLib,
        MCP_ENABLED: 'true',
        MCP_AUTH: 'none',
        MCP_TOKEN: 'short',
      });
      expect(config.mcpToken).toBeNull();
      expect(config.mcpTokenIgnored).toBe(true);
    });
  });

  it('MCP_AUTH不正値はthrow', async () => {
    await withLib((tmpLib) => {
      expect(() => loadConfig({ LIBRARY_PATH: tmpLib, MCP_ENABLED: 'true', MCP_AUTH: 'foo' })).toThrow(
        /MCP_AUTH は token \/ none/,
      );
    });
  });

  it('MCP_AUTH未設定・空文字・tokenは従来どおりMCP_TOKEN必須', async () => {
    await withLib((tmpLib) => {
      for (const auth of [undefined, '', 'token']) {
        expect(() =>
          loadConfig({ LIBRARY_PATH: tmpLib, MCP_ENABLED: 'true', MCP_AUTH: auth }),
        ).toThrow(/MCP_TOKEN/);
      }
      const config = loadConfig({
        LIBRARY_PATH: tmpLib,
        MCP_ENABLED: 'true',
        MCP_TOKEN: TOKEN,
      });
      expect(config.mcpAuth).toBe('token');
      expect(config.mcpToken).toBe(TOKEN);
    });
  });
});

describe('POST /mcp 認証なしモード(MCP_AUTH=none)', () => {
  beforeEach(async () => {
    await buildMcpApp({ MCP_AUTH: 'none', MCP_TOKEN: undefined });
  });

  function noAuthRequest(
    body: unknown,
    opts: { remoteAddress?: string; headers?: Record<string, string> } = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/mcp',
      remoteAddress: opts.remoteAddress,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...opts.headers,
      },
      payload: body as never,
    });
  }

  const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

  it('ループバックからAuthorizationなしでinitializeできる', async () => {
    const res = await noAuthRequest(INITIALIZE_PAYLOAD, { remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(200);
  });

  it('ループバックからAuthorizationなしでtools/listできる', async () => {
    const res = await noAuthRequest(TOOLS_LIST, { remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('search_notes');
  });

  it('Tailscale(100.64.0.0/10)からは200', async () => {
    const res = await noAuthRequest(TOOLS_LIST, { remoteAddress: '100.100.1.1' });
    expect(res.statusCode).toBe(200);
  });

  it('LAN(192.168.x.x)からは200', async () => {
    const res = await noAuthRequest(TOOLS_LIST, { remoteAddress: '192.168.1.20' });
    expect(res.statusCode).toBe(200);
  });

  it('グローバルIPからは403', async () => {
    const res = await noAuthRequest(TOOLS_LIST, { remoteAddress: '8.8.8.8' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('ソケットがループバックでもX-Forwarded-Forが外部アドレスなら403', async () => {
    const res = await noAuthRequest(TOOLS_LIST, {
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.5' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('X-Forwarded-Forの一部でも外部アドレスがあれば403', async () => {
    const res = await noAuthRequest(TOOLS_LIST, {
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '100.101.1.1, 203.0.113.5' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('X-Forwarded-ForがTailscaleアドレスなら200(Tailscale Serve相当)', async () => {
    const res = await noAuthRequest(TOOLS_LIST, {
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '100.101.1.1' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('Forwardedヘッダーの外部アドレスは403', async () => {
    const res = await noAuthRequest(TOOLS_LIST, {
      remoteAddress: '127.0.0.1',
      headers: { forwarded: 'for="[2001:db8::1]:1234"' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('CF-Connecting-IPの外部アドレスは403', async () => {
    const res = await noAuthRequest(TOOLS_LIST, {
      remoteAddress: '127.0.0.1',
      headers: { 'cf-connecting-ip': '203.0.113.5' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('X-Real-IP / True-Client-IPの外部アドレスは403', async () => {
    for (const name of ['x-real-ip', 'true-client-ip']) {
      const res = await noAuthRequest(TOOLS_LIST, {
        remoteAddress: '127.0.0.1',
        headers: { [name]: '203.0.113.5' },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('Originヘッダ付き(ブラウザ発)は送信元がループバックでも403', async () => {
    const res = await noAuthRequest(TOOLS_LIST, {
      remoteAddress: '127.0.0.1',
      headers: { origin: 'http://evil.example:3000' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('ブラウザ');
  });

  it('Sec-Fetch-Site/Mode/Destのいずれか単独でも403', async () => {
    for (const [name, value] of [
      ['sec-fetch-site', 'same-origin'],
      ['sec-fetch-mode', 'cors'],
      ['sec-fetch-dest', 'empty'],
    ]) {
      const res = await noAuthRequest(TOOLS_LIST, {
        remoteAddress: '127.0.0.1',
        headers: { [name]: value },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('GETでもSec-Fetch-Siteがあれば403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/mcp',
      remoteAddress: '127.0.0.1',
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('パーセントエンコードしたパス(/%6dcp, /m%63p)でも送信元制限が効く', async () => {
    for (const url of ['/%6dcp', '/m%63p']) {
      const res = await app.inject({
        method: 'POST',
        url,
        remoteAddress: '8.8.8.8',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: TOOLS_LIST as never,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('/api/healthはMCPの送信元制限の影響を受けない', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '8.8.8.8' });
    expect(res.statusCode).toBe(200);
  });

  it('Authorizationヘッダを付けても送信元制限は効く', async () => {
    const res = await noAuthRequest(TOOLS_LIST, {
      remoteAddress: '8.8.8.8',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
