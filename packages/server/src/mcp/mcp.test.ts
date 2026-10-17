import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('POST /mcp JSON-RPC', () => {
  beforeEach(async () => {
    await buildMcpApp();
  });

  it('initializeでserverInfo.nameがtsumiwikiになる', async () => {
    const res = await mcpRequest(INITIALIZE_PAYLOAD);
    expect(res.statusCode).toBe(200);
    expect(res.json().result.serverInfo.name).toBe('tsumiwiki');
  });

  it('tools/listで期待する11個のツール名が全て含まれる', async () => {
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
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
    expect(expected).toHaveLength(11);
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
