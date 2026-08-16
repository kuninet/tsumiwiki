import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
