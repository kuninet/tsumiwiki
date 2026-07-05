import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';

// 検索・タグ・最近更新APIのテスト(FR-NAV-02/03/04)

const CSRF = { 'x-requested-with': 'TsumiWiki' };

type App = ReturnType<typeof buildApp>;
let app: App;
let lib: string;
let cookie: string;

function api(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({ method, url, headers: { ...CSRF, cookie }, payload: payload as never });
}

beforeEach(async () => {
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-query-'));
  const config = loadConfig({ LIBRARY_PATH: lib });
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

  // テスト用文書を直接配置してインデックス
  await writeFile(
    join(lib, '設計方針.md'),
    '---\ntags: [設計, 重要]\n---\n\nデータベースのスキーマ設計について記述する。 #アーキテクチャ\n',
    'utf8',
  );
  await writeFile(
    join(lib, '買い物メモ.md'),
    '---\ntags: [メモ]\n---\n\n牛乳と卵とパンを買う。\n',
    'utf8',
  );
  await writeFile(join(lib, '議事録.md'), '#設計 の進め方を議論した。スキーマは来週決める。\n', 'utf8');
  await app.indexerService.scanAll();
});

afterEach(async () => {
  await app.close();
  await rm(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('全文検索', () => {
  it('日本語検索がヒットし、snippetにハイライトが付く', async () => {
    const res = await api('GET', `/api/search?q=${encodeURIComponent('スキーマ')}`);
    expect(res.statusCode).toBe(200);
    const results = res.json().results;
    expect(results.length).toBe(2);
    expect(results[0].snippet).toContain('<mark>');
  }, 20_000);

  it('複数語はAND検索になる(trigramのため各語3文字以上)', async () => {
    const res = await api('GET', `/api/search?q=${encodeURIComponent('スキーマ 進め方')}`);
    expect(res.json().results.map((r: { path: string }) => r.path)).toEqual(['議事録.md']);
  }, 20_000);

  it('FTS構文の特殊文字を含む検索が500にならない', async () => {
    for (const q of ['"未閉じ', 'a* OR b', '(かっこ', 'NEAR/3']) {
      const res = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
      expect(res.statusCode).toBe(200);
    }
  }, 20_000);

  it('空クエリは400', async () => {
    const res = await api('GET', '/api/search?q=%20');
    expect(res.statusCode).toBe(400);
  }, 20_000);
});

describe('タグ', () => {
  it('タグ一覧が件数つきで返る(frontmatter+inline両対応)', async () => {
    const res = await api('GET', '/api/tags');
    const tags = Object.fromEntries(
      res.json().tags.map((t: { tag: string; count: number }) => [t.tag, t.count]),
    );
    expect(tags['設計']).toBe(2); // frontmatter(設計方針)+inline(議事録)
    expect(tags['メモ']).toBe(1);
    expect(tags['アーキテクチャ']).toBe(1);
  }, 20_000);

  it('複数タグのAND絞り込みができる', async () => {
    const res = await api('GET', `/api/tags/docs?tags=${encodeURIComponent('設計,重要')}`);
    expect(res.json().docs.map((d: { path: string }) => d.path)).toEqual(['設計方針.md']);
  }, 20_000);

  it('#付き・空要素は正規化される', async () => {
    const res = await api('GET', `/api/tags/docs?tags=${encodeURIComponent('#メモ,,')}`);
    expect(res.json().docs.map((d: { path: string }) => d.path)).toEqual(['買い物メモ.md']);
  }, 20_000);
});

describe('最近更新', () => {
  it('更新日時の新しい順に返り、limitが効く', async () => {
    const res = await api('GET', '/api/docs/recent?limit=2');
    expect(res.json().docs.length).toBe(2);
    const dates = res.json().docs.map((d: { updatedAt: string }) => d.updatedAt);
    expect([...dates].sort().reverse()).toEqual(dates);
  }, 20_000);
});

describe('レビュー指摘の回帰テスト', () => {
  it('本文中のHTMLはsnippetでエスケープされ、markのみHTMLとして残る(XSS対策)', async () => {
    await writeFile(
      join(lib, '攻撃文書.md'),
      '検索用キーワードのスキーマと <img src=x onerror=alert(1)> を含む。\n',
      'utf8',
    );
    await app.indexerService.scanAll();

    const res = await api('GET', `/api/search?q=${encodeURIComponent('スキーマ')}`);
    const hit = res.json().results.find((r: { path: string }) => r.path === '攻撃文書.md');
    expect(hit).toBeTruthy();
    expect(hit.snippet).not.toContain('<img');
    expect(hit.snippet).toContain('&lt;img');
    expect(hit.snippet).toContain('<mark>');
  }, 20_000);

  it('重複タグ入力でもAND絞り込みが正しく動く', async () => {
    const res = await api('GET', `/api/tags/docs?tags=${encodeURIComponent('設計,設計')}`);
    expect(res.json().docs.map((d: { path: string }) => d.path)).toContain('設計方針.md');
  }, 20_000);

  it('recentのlimit端値(0・負・超過・非数値)が安全に扱われる', async () => {
    for (const [q, max] of [
      ['0', 1],
      ['-5', 1],
      ['1000', 100],
      ['abc', 20],
    ] as const) {
      const res = await api('GET', `/api/docs/recent?limit=${q}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().docs.length).toBeLessThanOrEqual(max);
    }
  }, 20_000);

  it('短い語のみ・ヒットなしの検索は空配列を返す', async () => {
    for (const q of ['x', '存在しない超長いキーワード']) {
      const res = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().results)).toBe(true);
    }
  }, 20_000);
});
