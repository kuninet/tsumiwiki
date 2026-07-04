import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { mkdtemp, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../db/index.js';
import { IndexerService } from './indexer-service';

// ライブラリインデックスサービスの検証(issue #21 / 設計02章2.3)
// - 日本語ファイル名・フォルダの走査、フロントマター/インラインタグ抽出
// - コードブロック除外、数字のみタグの無効化、壊れたYAMLの寛容な扱い
// - 差分リインデックス(indexed/removed/unchanged)、削除・移動の反映
// - doc_ftsによる日本語全文検索

let lib: string;
let db: AppDatabase;
let svc: IndexerService;

beforeEach(async () => {
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-index-'));
  db = openDatabase(':memory:');
  svc = new IndexerService(db, lib);
});

afterEach(async () => {
  db.close();
  await rm(lib, { recursive: true, force: true });
});

function docIndexRow(docPath: string): { doc_path: string; title: string; folder: string } | undefined {
  return db.prepare('SELECT doc_path, title, folder FROM doc_index WHERE doc_path = ?').get(docPath) as
    | { doc_path: string; title: string; folder: string }
    | undefined;
}

function tagsOf(docPath: string): { tag: string; source: string }[] {
  return db
    .prepare('SELECT tag, source FROM doc_tags WHERE doc_path = ? ORDER BY source, tag')
    .all(docPath) as { tag: string; source: string }[];
}

describe('IndexerService', () => {
  it('日本語ファイル名・フォルダが走査され、doc_indexにtitleとfolderが入る', async () => {
    await mkdir(join(lib, '議事録'), { recursive: true });
    await writeFile(join(lib, '議事録/週次ミーティング.md'), '# 週次\n', 'utf8');
    await writeFile(join(lib, 'ルート文書.md'), '# ルート\n', 'utf8');

    const result = await svc.scanAll();
    expect(result.indexed).toBe(2);

    const nested = docIndexRow('議事録/週次ミーティング.md');
    expect(nested?.title).toBe('週次ミーティング');
    expect(nested?.folder).toBe('議事録');

    const root = docIndexRow('ルート文書.md');
    expect(root?.title).toBe('ルート文書');
    expect(root?.folder).toBe('');
  });

  it('フロントマターtags(配列・カンマ区切り文字列・#付き)がsource=frontmatterで入る', async () => {
    await writeFile(
      join(lib, '配列タグ.md'),
      '---\ntags: [設計, 議事録]\n---\n本文A\n',
      'utf8',
    );
    await writeFile(
      join(lib, '文字列タグ.md'),
      '---\ntags: 設計, メモ\n---\n本文B\n',
      'utf8',
    );
    await writeFile(
      join(lib, 'シャープ付きタグ.md'),
      '---\ntags: ["#重要"]\n---\n本文C\n',
      'utf8',
    );

    await svc.scanAll();

    expect(tagsOf('配列タグ.md')).toEqual([
      { tag: '設計', source: 'frontmatter' },
      { tag: '議事録', source: 'frontmatter' },
    ]);
    expect(tagsOf('文字列タグ.md')).toEqual([
      { tag: 'メモ', source: 'frontmatter' },
      { tag: '設計', source: 'frontmatter' },
    ]);
    expect(tagsOf('シャープ付きタグ.md')).toEqual([{ tag: '重要', source: 'frontmatter' }]);
  });

  it('本文中の#タグ・#階層/タグがsource=inlineで入り、行頭のタグも取れる', async () => {
    const content = '#行頭タグ から始まる文書。\n本文中に #階層/タグ が含まれる。\n';
    await writeFile(join(lib, 'インラインタグ.md'), content, 'utf8');

    await svc.scanAll();

    expect(tagsOf('インラインタグ.md')).toEqual([
      { tag: '行頭タグ', source: 'inline' },
      { tag: '階層/タグ', source: 'inline' },
    ]);
  });

  it('コードブロック・インラインコード内の#タグは抽出されない', async () => {
    const content = [
      '通常の #有効タグ はここ。',
      '```',
      '#コード内タグ は無視される',
      '```',
      'インラインコード `#インライン内タグ` も無視される。',
      '',
    ].join('\n');
    await writeFile(join(lib, 'コード除外.md'), content, 'utf8');

    await svc.scanAll();

    expect(tagsOf('コード除外.md')).toEqual([{ tag: '有効タグ', source: 'inline' }]);
  });

  it('数字のみのタグ(#123)は無効', async () => {
    await writeFile(join(lib, '数字タグ.md'), '#123 は無効。 #タグ2 は有効。\n', 'utf8');

    await svc.scanAll();

    expect(tagsOf('数字タグ.md')).toEqual([{ tag: 'タグ2', source: 'inline' }]);
  });

  it('壊れたYAMLフロントマターでも文書はdoc_indexに入る(tagsは空)', async () => {
    await writeFile(join(lib, '壊れたYAML.md'), '---\ntags: [unclosed\n---\n本文\n', 'utf8');

    const result = await svc.scanAll();
    expect(result.indexed).toBe(1);
    expect(docIndexRow('壊れたYAML.md')).toBeDefined();
    expect(tagsOf('壊れたYAML.md')).toEqual([]);
  });

  it('.obsidian/ と .trash/ 配下の.mdは索引されない', async () => {
    await mkdir(join(lib, '.obsidian'), { recursive: true });
    await mkdir(join(lib, '.trash'), { recursive: true });
    await writeFile(join(lib, '.obsidian/workspace.md'), '設定\n', 'utf8');
    await writeFile(join(lib, '.trash/削除済み.md'), '削除済み\n', 'utf8');
    await writeFile(join(lib, '通常文書.md'), '通常\n', 'utf8');

    const result = await svc.scanAll();
    expect(result.indexed).toBe(1);
    expect(docIndexRow('.obsidian/workspace.md')).toBeUndefined();
    expect(docIndexRow('.trash/削除済み.md')).toBeUndefined();
    expect(docIndexRow('通常文書.md')).toBeDefined();
  });

  it('差分リインデックス: 変更なしはunchanged、内容変更(サイズ変化)はindexedになる', async () => {
    await writeFile(join(lib, '文書1.md'), '内容1\n', 'utf8');
    await writeFile(join(lib, '文書2.md'), '内容2\n', 'utf8');

    const first = await svc.scanAll();
    expect(first.indexed).toBe(2);
    expect(first.unchanged).toBe(0);

    const second = await svc.scanAll();
    expect(second.indexed).toBe(0);
    expect(second.unchanged).toBe(2);

    // mtimeの分解能に依存しないよう、サイズが変わる書き換えにする
    await writeFile(join(lib, '文書1.md'), '内容1を大幅に書き換えて長さを変える\n', 'utf8');
    const third = await svc.scanAll();
    expect(third.indexed).toBe(1);
    expect(third.unchanged).toBe(1);
    expect(third.removed).toBe(0);
  });

  it('削除検出: ファイル削除後のscanAllでremoved=1になり、各テーブルから消える', async () => {
    await writeFile(join(lib, '削除対象.md'), '内容\n', 'utf8');
    await svc.scanAll();
    expect(docIndexRow('削除対象.md')).toBeDefined();

    await unlink(join(lib, '削除対象.md'));
    const result = await svc.scanAll();
    expect(result.removed).toBe(1);

    expect(docIndexRow('削除対象.md')).toBeUndefined();
    expect(tagsOf('削除対象.md')).toEqual([]);
    const fts = db.prepare('SELECT doc_path FROM doc_fts WHERE doc_path = ?').get('削除対象.md');
    expect(fts).toBeUndefined();
  });

  it('moveFile: 旧パスの行が消え新パスで入る', async () => {
    await writeFile(join(lib, '旧名文書.md'), '#タグ 内容\n', 'utf8');
    await svc.scanAll();
    expect(docIndexRow('旧名文書.md')).toBeDefined();

    await rename(join(lib, '旧名文書.md'), join(lib, '新名文書.md'));
    await svc.moveFile('旧名文書.md', '新名文書.md');

    expect(docIndexRow('旧名文書.md')).toBeUndefined();
    const moved = docIndexRow('新名文書.md');
    expect(moved).toBeDefined();
    expect(moved?.title).toBe('新名文書');
    expect(tagsOf('新名文書.md')).toEqual([{ tag: 'タグ', source: 'inline' }]);
  });

  it('doc_ftsに対する日本語MATCH検索でヒットする', async () => {
    await mkdir(join(lib, '議事録'), { recursive: true });
    await writeFile(join(lib, '議事録/週次ミーティング.md'), '# 週次ミーティングの議事録\n', 'utf8');
    await writeFile(join(lib, '無関係.md'), '買い物リスト\n', 'utf8');

    await svc.scanAll();

    const hits = db
      .prepare('SELECT doc_path FROM doc_fts WHERE doc_fts MATCH ? ORDER BY rank')
      .all('ミーティング')
      .map((r) => (r as { doc_path: string }).doc_path);

    expect(hits).toEqual(['議事録/週次ミーティング.md']);
  });
});
