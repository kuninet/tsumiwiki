import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';

// #84 Phase B: テンプレート API のテスト

const CSRF = { 'x-requested-with': 'TsumiWiki' };

type App = ReturnType<typeof buildApp>;
let app: App;
let lib: string;
let yamada: string;
let admin: string;

async function loginAs(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: CSRF,
    payload: { username, password: 'p' },
  });
  return (res.headers['set-cookie'] as string).split(';')[0];
}

function apiAs(
  cookie: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return app.inject({ method, url, headers: { ...CSRF, cookie }, payload: payload as never });
}

// 指定パスにテンプレファイルを直接置く。API 経由の PUT は frontmatter を触れない
// (composeContent が外科的編集で本文しか差し込まない)ため、テストではフロントマター
// 込みの生ファイルとして書き込む。テンプレAPIは filesystem を直接歩くので index 反映は不要。
async function writeTemplate(relPath: string, content: string): Promise<void> {
  const abs = join(lib, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

beforeEach(async () => {
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-templates-'));
  const config = loadConfig({ LIBRARY_PATH: lib });
  const db = openDatabase(':memory:');
  app = buildApp({ config, db, logger: false });
  await app.ready();
  app.userService.create({ username: 'yamada', displayName: '山田', password: 'p', role: 'user' });
  app.userService.create({ username: 'admin', displayName: '管理者', password: 'p', role: 'admin' });
  yamada = await loginAs('yamada');
  admin = await loginAs('admin');
});

afterEach(async () => {
  await app.close();
  await rm(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('GET /api/templates', () => {
  it('未認証は401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/templates', headers: CSRF });
    expect(res.statusCode).toBe(401);
  }, 20_000);

  it('テンプレフォルダが未作成なら空配列', async () => {
    const res = await apiAs(yamada, 'GET', '/api/templates');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ templates: [] });
  }, 20_000);

  it('_templates 配下の .md をサブフォルダ含めて列挙し、frontmatter を抽出する', async () => {
    await writeTemplate(
      '_templates/日誌.md',
      '---\ntarget_folder: 日記\ndescription: 日々の記録\n---\n\n# {{title}}\n',
    );
    await writeTemplate('_templates/雑/週報.md', '# 週報 {{date}}\n');
    // ノイズ: md 以外は無視される
    await writeTemplate('_templates/README.md', 'ただの説明\n');

    const res = await apiAs(yamada, 'GET', '/api/templates');
    expect(res.statusCode).toBe(200);
    const templates = res.json().templates as Array<{
      path: string;
      name: string;
      targetFolder: string | null;
      description?: string;
    }>;

    const byPath = new Map(templates.map((t) => [t.path, t]));
    expect(byPath.get('_templates/日誌.md')).toMatchObject({
      name: '日誌',
      targetFolder: '日記',
      description: '日々の記録',
    });
    expect(byPath.get('_templates/雑/週報.md')).toMatchObject({
      name: '週報',
      targetFolder: null,
    });
    expect(byPath.has('_templates/README.md')).toBe(true);
  }, 30_000);

  it('設定でテンプレフォルダを変更すると新フォルダから列挙する', async () => {
    await writeTemplate('snippets/snippet.md', '# snippet\n');
    await apiAs(admin, 'PUT', '/api/library/settings', {
      templates: { folder: 'snippets' },
      dailyNotes: { folder: '日記', template: '', filenamePattern: 'YYYY-MM-DD' },
    });
    const res = await apiAs(yamada, 'GET', '/api/templates');
    expect(res.json().templates.map((t: { path: string }) => t.path)).toEqual([
      'snippets/snippet.md',
    ]);
  }, 30_000);

  it('.trash 配下の md は列挙しない(dot始まりセグメント一律除外)', async () => {
    await writeTemplate('_templates/生きているテンプレ.md', '# 生存\n');
    await writeTemplate('_templates/.trash/削除済.md', '# 消えた\n');
    const res = await apiAs(yamada, 'GET', '/api/templates');
    const paths = res.json().templates.map((t: { path: string }) => t.path);
    expect(paths).toContain('_templates/生きているテンプレ.md');
    expect(paths.some((p: string) => p.includes('.trash'))).toBe(false);
  }, 30_000);

  it('深いサブフォルダのテンプレも再帰列挙される', async () => {
    await writeTemplate('_templates/a/b/c/深い.md', '# 深い\n');
    const res = await apiAs(yamada, 'GET', '/api/templates');
    expect(res.json().templates.map((t: { path: string }) => t.path)).toContain(
      '_templates/a/b/c/深い.md',
    );
  }, 30_000);

  it('BOM 付き md でも frontmatter を認識してリストに載せる', async () => {
    await writeTemplate(
      '_templates/bom.md',
      '﻿---\ntarget_folder: 別\n---\n\n本文\n',
    );
    const res = await apiAs(yamada, 'GET', '/api/templates');
    const t = res
      .json()
      .templates.find((x: { path: string }) => x.path === '_templates/bom.md');
    expect(t).toBeTruthy();
    expect(t.targetFolder).toBe('別');
  }, 30_000);

  it('templates.folder が空文字だとテンプレ機能無効として空配列を返す(ルートスキャン防止)', async () => {
    await writeTemplate('_templates/x.md', '# x\n');
    await writeTemplate('無関係.md', '# root doc\n');
    await apiAs(admin, 'PUT', '/api/library/settings', {
      templates: { folder: '' },
      dailyNotes: { folder: '日記', template: '', filenamePattern: 'YYYY-MM-DD' },
    });
    const res = await apiAs(yamada, 'GET', '/api/templates');
    expect(res.json()).toEqual({ templates: [] });
  }, 30_000);
});

describe('POST /api/templates/apply', () => {
  it('未認証は401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/templates/apply',
      headers: CSRF,
      payload: { templatePath: '_templates/x.md', title: 'x' },
    });
    expect(res.statusCode).toBe(401);
  }, 20_000);

  it('必須パラメータ欠落は400', async () => {
    const res = await apiAs(yamada, 'POST', '/api/templates/apply', { templatePath: 'x' });
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it('frontmatter.target_folder を尊重して新規作成し、テンプレ用メタキーは新文書に残さない', async () => {
    await writeTemplate(
      '_templates/日誌.md',
      '---\ntarget_folder: 日記\ndescription: メタ\ncategory: log\n---\n\n# {{title}}\n\n担当: {{user}}\n',
    );

    const res = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '_templates/日誌.md',
      title: '20260707',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().path).toBe('日記/20260707.md');

    const doc = await apiAs(yamada, 'GET', '/api/docs?path=' + encodeURIComponent(res.json().path));
    const j = doc.json();
    expect(j.frontmatter.target_folder).toBeUndefined();
    expect(j.frontmatter.description).toBeUndefined();
    // 未知キーは残す(#84 Phase A 精神)
    expect(j.frontmatter.category).toBe('log');
    expect(j.body).toContain('# 20260707');
    expect(j.body).toContain('担当: 山田');
  }, 30_000);

  it('body.targetFolder は frontmatter を上書きする', async () => {
    await writeTemplate('_templates/日誌.md', '---\ntarget_folder: 日記\n---\n\n# {{title}}\n');
    const res = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '_templates/日誌.md',
      title: 'メモ',
      targetFolder: 'ノート',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().path).toBe('ノート/メモ.md');
  }, 30_000);

  it('frontmatter に target_folder が無くフォルダ未指定ならライブラリ直下に作成', async () => {
    await writeTemplate('_templates/plain.md', '# {{title}}\n');
    const res = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '_templates/plain.md',
      title: 'ノート',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().path).toBe('ノート.md');
  }, 30_000);

  it('同名文書が既にあれば409で拒否する', async () => {
    await writeTemplate('_templates/plain.md', '# {{title}}\n');
    const first = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '_templates/plain.md',
      title: '同名',
    });
    expect(first.statusCode).toBe(201);
    const second = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '_templates/plain.md',
      title: '同名',
    });
    expect(second.statusCode).toBe(409);
  }, 30_000);

  it('存在しないテンプレは404', async () => {
    const res = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '_templates/no-such.md',
      title: 'x',
    });
    expect(res.statusCode).toBe(404);
  }, 20_000);

  it('保護パス / トラバーサル / 非 .md のテンプレは 400', async () => {
    for (const bad of ['.git/config', '../etc/passwd', '_templates/x.txt', '']) {
      const res = await apiAs(yamada, 'POST', '/api/templates/apply', {
        templatePath: bad,
        title: 'x',
      });
      expect(res.statusCode).toBe(400);
    }
  }, 30_000);

  it('タイトルに FS 禁止文字を含んでも sanitizeTitle が全角化してファイル名に使う', async () => {
    await writeTemplate('_templates/plain.md', '# {{title}}\n');
    const res = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '_templates/plain.md',
      title: 'a:b*c',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().path).toBe('a：b＊c.md');
    // 本文の {{title}} は生の入力("a:b*c")のまま(ファイル名だけ sanitize)
    const doc = await apiAs(yamada, 'GET', '/api/docs?path=' + encodeURIComponent(res.json().path));
    expect(doc.json().body).toContain('# a:b*c');
  }, 30_000);

  it('保護フォルダ(.git 等)への作成は 400', async () => {
    await writeTemplate('_templates/plain.md', '# {{title}}\n');
    const res = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '_templates/plain.md',
      title: 'x',
      targetFolder: '.git',
    });
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it('生成された文書は git にコミットされる(LF・末尾改行)', async () => {
    await writeTemplate('_templates/plain.md', '# {{title}}\n');
    const res = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '_templates/plain.md',
      title: '記録',
    });
    expect(res.statusCode).toBe(201);
    const abs = join(lib, '記録.md');
    const raw = await readFile(abs, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.includes('\r')).toBe(false);
  }, 30_000);

  it('frontmatter のコメント・キー順・型を保全して他キーを残す(外科的編集)', async () => {
    // gray-matter + stringify では # コメントが落ち、'01' → 1 と型が変わっていた(Opusレビュー 中#3)
    await writeTemplate(
      '_templates/preserve.md',
      [
        '---',
        '# 分類は運用で増やす',
        "severity: '01'",
        'target_folder: 保存',
        'description: これは落ちる',
        'category: log',
        '---',
        '',
        '# {{title}}',
        '',
      ].join('\n'),
    );
    const res = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '_templates/preserve.md',
      title: '保全確認',
    });
    expect(res.statusCode).toBe(201);
    const abs = join(lib, '保存/保全確認.md');
    const raw = await readFile(abs, 'utf8');
    // コメントが残る
    expect(raw).toContain('# 分類は運用で増やす');
    // 型が保たれる('01' のクオートが残る)
    expect(raw).toContain("severity: '01'");
    // 未知キーは残る
    expect(raw).toContain('category: log');
    // テンプレメタは落ちる
    expect(raw).not.toContain('target_folder');
    expect(raw).not.toContain('description');
  }, 30_000);

  it('BOM 付きテンプレでも frontmatter を認識して展開し、BOM を新文書に持ち込まない', async () => {
    await writeTemplate(
      '_templates/bom-apply.md',
      '﻿---\ntarget_folder: 別\n---\n\n# {{title}}\n',
    );
    const res = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '_templates/bom-apply.md',
      title: 'ノート',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().path).toBe('別/ノート.md');
    const abs = join(lib, '別/ノート.md');
    const raw = await readFile(abs, 'utf8');
    expect(raw.charCodeAt(0)).not.toBe(0xfeff);
  }, 30_000);

  it('空文字の targetFolder は未指定と同義に扱う(frontmatter の target_folder を尊重)', async () => {
    await writeTemplate('_templates/e.md', '---\ntarget_folder: 保存先\n---\n\n# {{title}}\n');
    const res = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '_templates/e.md',
      title: 'x',
      targetFolder: '',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().path).toBe('保存先/x.md');
  }, 30_000);

  it('target_folder に Windows 予約名を含むと 400', async () => {
    await writeTemplate('_templates/plain.md', '# {{title}}\n');
    // 直接指定
    const r1 = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '_templates/plain.md',
      title: 'x',
      targetFolder: 'CON',
    });
    expect(r1.statusCode).toBe(400);
    // 中のセグメント
    const r2 = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '_templates/plain.md',
      title: 'x',
      targetFolder: '通常/NUL/中',
    });
    expect(r2.statusCode).toBe(400);
  }, 30_000);

  it('frontmatter の target_folder に .git 等の保護パスがあると 400', async () => {
    await writeTemplate(
      '_templates/malicious.md',
      '---\ntarget_folder: .git\n---\n\n# {{title}}\n',
    );
    const res = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '_templates/malicious.md',
      title: 'x',
    });
    expect(res.statusCode).toBe(400);
  }, 20_000);

  it('空 frontmatter (---\\n---\\n) のテンプレも本文を展開して作成できる', async () => {
    await writeTemplate('_templates/emptyfm.md', '---\n---\n\n# {{title}}\n');
    const res = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '_templates/emptyfm.md',
      title: '空FM',
    });
    expect(res.statusCode).toBe(201);
    const doc = await apiAs(yamada, 'GET', '/api/docs?path=' + encodeURIComponent(res.json().path));
    expect(doc.json().frontmatter).toEqual({});
    expect(doc.json().body).toContain('# 空FM');
  }, 30_000);
});

describe('POST /api/templates/expand (#84 Phase C)', () => {
  it('未認証は401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/templates/expand',
      headers: CSRF,
      payload: { templatePath: '_templates/x.md', title: 'x' },
    });
    expect(res.statusCode).toBe(401);
  }, 20_000);

  it('必須パラメータ欠落は400', async () => {
    const r1 = await apiAs(yamada, 'POST', '/api/templates/expand', {
      templatePath: '_templates/x.md',
    });
    expect(r1.statusCode).toBe(400);
    const r2 = await apiAs(yamada, 'POST', '/api/templates/expand', { title: 'x' });
    expect(r2.statusCode).toBe(400);
  }, 20_000);

  it('frontmatter は完全に落ちて本文だけが返る。変数は展開され、{{cursor}} は残る', async () => {
    await writeTemplate(
      '_templates/insert.md',
      '---\ntarget_folder: 落ちる\ncategory: メモ\n---\n\n## {{title}}\n\n担当: {{user}}\n{{cursor}}\n本日:\n',
    );
    const res = await apiAs(yamada, 'POST', '/api/templates/expand', {
      templatePath: '_templates/insert.md',
      title: '現行文書',
    });
    expect(res.statusCode).toBe(200);
    const md = res.json().markdown as string;
    // frontmatter は残らない
    expect(md).not.toContain('---');
    expect(md).not.toContain('target_folder');
    expect(md).not.toContain('category: メモ');
    // 変数は展開される
    expect(md).toContain('## 現行文書');
    expect(md).toContain('担当: 山田');
    // cursor はマーカーとして残る(クライアントが split する)
    expect(md).toContain('{{cursor}}');
  }, 30_000);

  it('frontmatter を持たないテンプレでも本文をそのまま返す', async () => {
    await writeTemplate('_templates/plain.md', '- 項目1: {{date}}\n- 項目2\n');
    const res = await apiAs(yamada, 'POST', '/api/templates/expand', {
      templatePath: '_templates/plain.md',
      title: '文書',
    });
    expect(res.statusCode).toBe(200);
    const md = res.json().markdown as string;
    expect(md.startsWith('- 項目1: ')).toBe(true);
    expect(md).toContain('- 項目2');
  }, 30_000);

  it('BOM 付きテンプレでも frontmatter を認識して展開する', async () => {
    await writeTemplate(
      '_templates/bom-exp.md',
      '﻿---\ncategory: log\n---\n\n本文 {{title}}\n',
    );
    const res = await apiAs(yamada, 'POST', '/api/templates/expand', {
      templatePath: '_templates/bom-exp.md',
      title: 'X',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().markdown).toBe('本文 X\n');
  }, 30_000);

  it('保護パス / トラバーサル / 非 .md は 400', async () => {
    for (const bad of ['.git/config', '../etc/passwd', '_templates/x.txt', '']) {
      const res = await apiAs(yamada, 'POST', '/api/templates/expand', {
        templatePath: bad,
        title: 'x',
      });
      expect(res.statusCode).toBe(400);
    }
  }, 30_000);

  it('存在しないテンプレは 404', async () => {
    const res = await apiAs(yamada, 'POST', '/api/templates/expand', {
      templatePath: '_templates/none.md',
      title: 'x',
    });
    expect(res.statusCode).toBe(404);
  }, 20_000);

  it('複数の {{cursor}} があっても 2 番目以降のマーカーとその後のテキストは本文に保全される', async () => {
    // 重大#1 の回帰: split(sep, 2) は 2 番目以降のマーカー右側を捨ててしまう
    await writeTemplate('_templates/multi.md', '# {{title}}\n\nA{{cursor}}B{{cursor}}C\n');
    const res = await apiAs(yamada, 'POST', '/api/templates/expand', {
      templatePath: '_templates/multi.md',
      title: '複数',
    });
    expect(res.statusCode).toBe(200);
    const md = res.json().markdown as string;
    // マーカー総数 2 個は全て残す(client 側で最初のマーカーで split する)。
    // A/B/C いずれも消えていないことが重要
    expect(md).toContain('A');
    expect(md).toContain('B');
    expect(md).toContain('C');
    const markerCount = md.split('{{cursor}}').length - 1;
    expect(markerCount).toBe(2);
  }, 30_000);

  it('テンプレフォルダ外の md を expand しようとすると 400(通常文書を勝手にテンプレ扱いさせない)', async () => {
    await writeTemplate('_templates/ok.md', '# {{title}}\n');
    await writeTemplate('通常/文書.md', '## 見出し {{title}}\n');
    const outOfScope = await apiAs(yamada, 'POST', '/api/templates/expand', {
      templatePath: '通常/文書.md',
      title: 'X',
    });
    expect(outOfScope.statusCode).toBe(400);
    // 対照: scope 内の md は通る
    const inScope = await apiAs(yamada, 'POST', '/api/templates/expand', {
      templatePath: '_templates/ok.md',
      title: 'X',
    });
    expect(inScope.statusCode).toBe(200);
  }, 30_000);

  it('templates.folder が空文字ならテンプレ機能無効として expand も 400', async () => {
    await writeTemplate('_templates/x.md', '# {{title}}\n');
    await apiAs(admin, 'PUT', '/api/library/settings', {
      templates: { folder: '' },
      dailyNotes: { folder: '日記', template: '', filenamePattern: 'YYYY-MM-DD' },
    });
    const res = await apiAs(yamada, 'POST', '/api/templates/expand', {
      templatePath: '_templates/x.md',
      title: 'X',
    });
    expect(res.statusCode).toBe(400);
  }, 20_000);
});

describe('POST /api/templates/apply (#84 Phase C 追加分)', () => {
  it('テンプレフォルダ外の md は apply でも 400', async () => {
    await writeTemplate('通常/文書.md', '# 通常\n');
    const res = await apiAs(yamada, 'POST', '/api/templates/apply', {
      templatePath: '通常/文書.md',
      title: 'X',
    });
    expect(res.statusCode).toBe(400);
  }, 20_000);
});
