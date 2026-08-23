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

  it('2文字のクエリがLIKEフォールバックでヒットし、snippetにハイライトが付く', async () => {
    const res = await api('GET', `/api/search?q=${encodeURIComponent('牛乳')}`);
    expect(res.statusCode).toBe(200);
    const results = res.json().results;
    expect(results.map((r: { path: string }) => r.path)).toEqual(['買い物メモ.md']);
    expect(results[0].snippet).toContain('<mark>牛乳</mark>');
  }, 20_000);

  it('1文字のクエリもヒットする', async () => {
    const res = await api('GET', `/api/search?q=${encodeURIComponent('卵')}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: { path: string }) => r.path)).toEqual(['買い物メモ.md']);
  }, 20_000);

  it('短い語と長い語の混在はANDになる', async () => {
    const res1 = await api('GET', `/api/search?q=${encodeURIComponent('設計 スキーマ')}`);
    expect(res1.json().results.map((r: { path: string }) => r.path).sort()).toEqual(
      ['設計方針.md', '議事録.md'].sort(),
    );

    const res2 = await api('GET', `/api/search?q=${encodeURIComponent('牛乳 スキーマ')}`);
    expect(res2.json().results.length).toBe(0);
  }, 20_000);

  it('タイトルのみ一致でもヒットする', async () => {
    const res = await api('GET', `/api/search?q=${encodeURIComponent('議事')}`);
    expect(res.statusCode).toBe(200);
    const results = res.json().results;
    expect(results.map((r: { path: string }) => r.path)).toEqual(['議事録.md']);
    expect(results[0].snippet).not.toContain('<mark>');
  }, 20_000);

  it('LIKEワイルドカードはエスケープされる', async () => {
    await writeFile(join(lib, 'パーセント.md'), '進捗は100%です。\n', 'utf8');
    await writeFile(join(lib, '円.md'), '費用は100円です。\n', 'utf8');
    await writeFile(join(lib, 'アンダースコア.md'), '変数名はa_bです。\n', 'utf8');
    await writeFile(join(lib, 'エックス.md'), '変数名はaxbです。\n', 'utf8');
    await app.indexerService.scanAll();

    const res1 = await api('GET', `/api/search?q=${encodeURIComponent('0%')}`);
    expect(res1.json().results.map((r: { path: string }) => r.path)).toEqual(['パーセント.md']);

    const res2 = await api('GET', `/api/search?q=${encodeURIComponent('_')}`);
    expect(res2.json().results.map((r: { path: string }) => r.path)).toEqual(['アンダースコア.md']);
  }, 20_000);

  it('LIKE経路のsnippetも本文HTMLがエスケープされる', async () => {
    await writeFile(
      join(lib, 'XSS文書.md'),
      '牛乳を買う <script>alert(1)</script>\n',
      'utf8',
    );
    await app.indexerService.scanAll();

    const res = await api('GET', `/api/search?q=${encodeURIComponent('牛乳')}`);
    const hit = res.json().results.find((r: { path: string }) => r.path === 'XSS文書.md');
    expect(hit).toBeTruthy();
    expect(hit.snippet).not.toContain('<script>');
    expect(hit.snippet).toContain('&lt;script&gt;');
    expect(hit.snippet).toContain('<mark>牛乳</mark>');
  }, 20_000);

  it('サロゲートペア(絵文字)が混在する本文でもハイライト位置がずれない', async () => {
    await writeFile(join(lib, '絵文字1.md'), '🍎🍎🍎牛乳を買う\n', 'utf8');
    await app.indexerService.scanAll();

    const res = await api('GET', `/api/search?q=${encodeURIComponent('牛乳')}`);
    const hit = res.json().results.find((r: { path: string }) => r.path === '絵文字1.md');
    expect(hit).toBeTruthy();
    expect(hit.snippet).toContain('<mark>牛乳</mark>');
    expect(hit.snippet).not.toContain('<mark>買う</mark>');
  }, 20_000);

  it('絵文字直後の末尾ヒットでも正しい範囲がハイライトされる', async () => {
    await writeFile(join(lib, '絵文字2.md'), '🍎🍎🍎🍎🍎牛乳', 'utf8');
    await app.indexerService.scanAll();

    const res = await api('GET', `/api/search?q=${encodeURIComponent('牛乳')}`);
    const hit = res.json().results.find((r: { path: string }) => r.path === '絵文字2.md');
    expect(hit).toBeTruthy();
    expect(hit.snippet).toBe('🍎🍎🍎🍎🍎<mark>牛乳</mark>');
  }, 20_000);

  it('窓の途中でヒットした場合、前後に…が付く', async () => {
    const body = 'あ'.repeat(45) + '牛乳' + 'い'.repeat(40);
    await writeFile(join(lib, '長文.md'), body, 'utf8');
    await app.indexerService.scanAll();

    const res = await api('GET', `/api/search?q=${encodeURIComponent('牛乳')}`);
    const hit = res.json().results.find((r: { path: string }) => r.path === '長文.md');
    expect(hit).toBeTruthy();
    expect(hit.snippet.startsWith('…')).toBe(true);
    expect(hit.snippet.endsWith('…')).toBe(true);
    expect(hit.snippet).toContain('<mark>牛乳</mark>');
  }, 20_000);

  it('同一語が複数回出現する場合は全てハイライトされる', async () => {
    await writeFile(join(lib, '重複出現.md'), '牛乳と牛乳をたくさん買う。\n', 'utf8');
    await app.indexerService.scanAll();

    const res = await api('GET', `/api/search?q=${encodeURIComponent('牛乳')}`);
    const hit = res.json().results.find((r: { path: string }) => r.path === '重複出現.md');
    expect(hit).toBeTruthy();
    expect(hit.snippet.match(/<mark>/g)?.length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it('ASCII文字は大文字小文字を無視してハイライトされる', async () => {
    await writeFile(join(lib, '英語文書.md'), 'MILKです。\n', 'utf8');
    await app.indexerService.scanAll();

    const res = await api('GET', `/api/search?q=${encodeURIComponent('mi')}`);
    const hit = res.json().results.find((r: { path: string }) => r.path === '英語文書.md');
    expect(hit).toBeTruthy();
    expect(hit.snippet).toContain('<mark>MI</mark>');
  }, 20_000);

  it('バックスラッシュを含むクエリが正しくエスケープされる', async () => {
    await writeFile(join(lib, 'パス1.md'), 'パスは C:\\temp です。\n', 'utf8');
    await writeFile(join(lib, 'パス2.md'), 'パスは C:/temp です。\n', 'utf8');
    await app.indexerService.scanAll();

    const res = await api('GET', `/api/search?q=${encodeURIComponent('\\')}`);
    expect(res.json().results.map((r: { path: string }) => r.path)).toEqual(['パス1.md']);
  }, 20_000);

  it('タイトル一致は更新日時に関わらず本文のみ一致より先に返る', async () => {
    await writeFile(join(lib, '花見会.md'), '来月のイベントについて。\n', 'utf8');
    await writeFile(join(lib, 'イベント案内.md'), '来月は花見に行く予定です。\n', 'utf8');
    await app.indexerService.scanAll();

    // 本文のみ一致の文書の方を新しくして、単純な更新日時順では逆転することを確認した上でテストする
    app.db
      .prepare('UPDATE doc_index SET updated_at = ? WHERE doc_path = ?')
      .run('2020-01-01T00:00:00.000Z', '花見会.md');
    app.db
      .prepare('UPDATE doc_index SET updated_at = ? WHERE doc_path = ?')
      .run('2030-01-01T00:00:00.000Z', 'イベント案内.md');

    const res = await api('GET', `/api/search?q=${encodeURIComponent('花見')}`);
    expect(res.json().results.map((r: { path: string }) => r.path)).toEqual([
      '花見会.md',
      'イベント案内.md',
    ]);
  }, 20_000);

  it('LIKE経路も既定件数(50件)を超えて返さない', async () => {
    for (let i = 0; i < 51; i++) {
      await writeFile(join(lib, `件数文書${i}.md`), 'これは検証用の本文です。\n', 'utf8');
    }
    await app.indexerService.scanAll();

    const res = await api('GET', `/api/search?q=${encodeURIComponent('検証')}`);
    expect(res.json().results.length).toBe(50);
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
