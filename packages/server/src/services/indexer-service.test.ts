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
  await rm(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

function attachmentRow(
  relPath: string,
): { rel_path: string; name: string; name_key: string; folder: string } | undefined {
  return db
    .prepare('SELECT rel_path, name, name_key, folder FROM attachment_index WHERE rel_path = ?')
    .get(relPath) as
    | { rel_path: string; name: string; name_key: string; folder: string }
    | undefined;
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

describe('IndexerService: 堅牢性(レビュー指摘対応)', () => {
  it('読めないファイルが混ざってもscanAllは継続し、他の文書は索引される', async () => {
    const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { openDatabase } = await import('../db/index.js');
    const { IndexerService } = await import('./indexer-service.js');

    const lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-robust-'));
    try {
      await writeFile(join(lib, '正常.md'), '読める文書\n', 'utf8');
      await writeFile(join(lib, '読めない.md'), '権限なし\n', 'utf8');
      await chmod(join(lib, '読めない.md'), 0o000);

      const db = openDatabase(':memory:');
      const svc = new IndexerService(db, lib);
      const result = await svc.scanAll();

      expect(result.indexed).toBe(1);
      expect(result.failedPaths).toEqual(['読めない.md']);
      const rows = db.prepare('SELECT doc_path FROM doc_index').all() as { doc_path: string }[];
      expect(rows.map((r) => r.doc_path)).toEqual(['正常.md']);
    } finally {
      await chmod(join(lib, '読めない.md'), 0o644).catch(() => {});
      await rm(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);

  it('ネストした.trashフォルダも索引から除外される', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { openDatabase } = await import('../db/index.js');
    const { IndexerService } = await import('./indexer-service.js');

    const lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-nest-'));
    try {
      await mkdir(join(lib, 'サブ', '.trash'), { recursive: true });
      await writeFile(join(lib, 'サブ', '.trash', '削除済み.md'), 'x\n', 'utf8');
      await writeFile(join(lib, 'サブ', '通常.md'), 'y\n', 'utf8');

      const db = openDatabase(':memory:');
      const svc = new IndexerService(db, lib);
      await svc.scanAll();

      const rows = db.prepare('SELECT doc_path FROM doc_index').all() as { doc_path: string }[];
      expect(rows.map((r) => r.doc_path)).toEqual(['サブ/通常.md']);
    } finally {
      await rm(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);
});

// 添付ファイル索引(issue #198)。ヴォルト全体のファイル名索引でObsidian同等の解決を行う
describe('IndexerService: 添付索引(attachment_index)', () => {
  it('ルート/サブフォルダ/サブフォルダのattachments配下の画像が索引される', async () => {
    await mkdir(join(lib, 'サブ', 'attachments'), { recursive: true });
    await writeFile(join(lib, 'ルート画像.png'), 'a', 'utf8');
    await writeFile(join(lib, 'サブ', 'サブ画像.jpg'), 'b', 'utf8');
    await writeFile(join(lib, 'サブ', 'attachments', '添付画像.gif'), 'c', 'utf8');
    await writeFile(join(lib, '通常文書.md'), '本文\n', 'utf8');

    const result = await svc.scanAll();
    // .mdのindexed件数は添付に影響されない
    expect(result.indexed).toBe(1);
    expect(result.attachmentsIndexed).toBe(3);

    expect(attachmentRow('ルート画像.png')).toMatchObject({
      name: 'ルート画像.png',
      name_key: 'ルート画像.png',
      folder: '',
    });
    expect(attachmentRow('サブ/サブ画像.jpg')).toMatchObject({
      name: 'サブ画像.jpg',
      folder: 'サブ',
    });
    expect(attachmentRow('サブ/attachments/添付画像.gif')).toMatchObject({
      name: '添付画像.gif',
      folder: 'サブ/attachments',
    });
  });

  it('NFDで書かれたファイル名もNFCキーで索引・解決される', async () => {
    // 'が' = 'か'(U+304B) + 濁点(U+3099)の分解形(NFD)で明示的に書き込む
    const nfdName = 'が.png'.normalize('NFD');
    expect(nfdName).not.toBe('が.png'); // 前提: 実際に分解形になっていること
    await writeFile(join(lib, nfdName), 'x', 'utf8');

    const result = await svc.scanAll();
    expect(result.attachmentsIndexed).toBe(1);
    expect(attachmentRow('が.png')).toMatchObject({ name: 'が.png', name_key: 'が.png' });
    expect(svc.resolveAttachment('が.png', '')).toBe('が.png');
  });

  it('.trash直下・ネストした.trash・.obsidian配下の画像は索引されずresolveAttachmentもnull', async () => {
    await mkdir(join(lib, '.trash'), { recursive: true });
    await mkdir(join(lib, 'サブ', '.trash'), { recursive: true });
    await mkdir(join(lib, '.obsidian'), { recursive: true });
    await writeFile(join(lib, '.trash', 'ごみ.png'), 'a', 'utf8');
    await writeFile(join(lib, 'サブ', '.trash', 'ネストごみ.png'), 'b', 'utf8');
    await writeFile(join(lib, '.obsidian', '設定画像.png'), 'c', 'utf8');

    const result = await svc.scanAll();
    expect(result.attachmentsIndexed).toBe(0);
    expect(attachmentRow('.trash/ごみ.png')).toBeUndefined();
    expect(attachmentRow('サブ/.trash/ネストごみ.png')).toBeUndefined();
    expect(attachmentRow('.obsidian/設定画像.png')).toBeUndefined();
    expect(svc.resolveAttachment('ごみ.png', '')).toBeNull();
    expect(svc.resolveAttachment('ネストごみ.png', '')).toBeNull();
    expect(svc.resolveAttachment('設定画像.png', '')).toBeNull();
  });

  it('差分: 2回目のscanAllで変更なし、移動で旧行が消え新行が入り、削除で消える', async () => {
    await writeFile(join(lib, '画像A.png'), 'x', 'utf8');
    const first = await svc.scanAll();
    expect(first.attachmentsIndexed).toBe(1);

    const second = await svc.scanAll();
    expect(second.attachmentsIndexed).toBe(0);
    expect(second.attachmentsRemoved).toBe(0);

    await mkdir(join(lib, '移動先'), { recursive: true });
    await rename(join(lib, '画像A.png'), join(lib, '移動先', '画像A.png'));
    const third = await svc.scanAll();
    expect(attachmentRow('画像A.png')).toBeUndefined();
    expect(attachmentRow('移動先/画像A.png')).toBeDefined();
    expect(third.attachmentsIndexed).toBe(1);
    expect(third.attachmentsRemoved).toBe(1);

    await unlink(join(lib, '移動先', '画像A.png'));
    const fourth = await svc.scanAll();
    expect(fourth.attachmentsRemoved).toBe(1);
    expect(attachmentRow('移動先/画像A.png')).toBeUndefined();
  });

  it('indexAttachment/moveAttachment/removeAttachmentで個別に索引を操作できる', async () => {
    await writeFile(join(lib, '個別画像.png'), 'x', 'utf8');
    await svc.indexAttachment('個別画像.png');
    expect(attachmentRow('個別画像.png')).toBeDefined();

    await rename(join(lib, '個別画像.png'), join(lib, '個別画像2.png'));
    await svc.moveAttachment('個別画像.png', '個別画像2.png');
    expect(attachmentRow('個別画像.png')).toBeUndefined();
    expect(attachmentRow('個別画像2.png')).toBeDefined();

    svc.removeAttachment('個別画像2.png');
    expect(attachmentRow('個別画像2.png')).toBeUndefined();
  });
});

describe('IndexerService: resolveAttachment(issue #198 解決規則)', () => {
  it('名前一致で解決できる(大文字小文字は区別しない)', async () => {
    await writeFile(join(lib, '画像.PNG'), 'x', 'utf8');
    await svc.scanAll();
    expect(svc.resolveAttachment('画像.png', '')).toBe('画像.PNG');
    expect(svc.resolveAttachment('画像.PNG', '')).toBe('画像.PNG');
  });

  it('パス末尾一致で解決できる(大文字小文字は区別しない)', async () => {
    await mkdir(join(lib, '深い', 'Sub'), { recursive: true });
    await writeFile(join(lib, '深い', 'Sub', 'inner.png'), 'x', 'utf8');
    await svc.scanAll();
    // 完全一致
    expect(svc.resolveAttachment('深い/Sub/inner.png', '')).toBe('深い/Sub/inner.png');
    // パス末尾一致(浅い指定で深い実パスに解決)
    expect(svc.resolveAttachment('Sub/inner.png', '')).toBe('深い/Sub/inner.png');
    // 大文字小文字は区別しない
    expect(svc.resolveAttachment('sub/INNER.PNG', '')).toBe('深い/Sub/inner.png');
    // 一致しないパスはnull
    expect(svc.resolveAttachment('other/inner.png', '')).toBeNull();
  });

  it('未登録のtargetはnull、..セグメントは拒否される', async () => {
    await svc.scanAll();
    expect(svc.resolveAttachment('存在しない.png', '')).toBeNull();
    expect(svc.resolveAttachment('../secret.png', '')).toBeNull();
    expect(svc.resolveAttachment('a/../../secret.png', '')).toBeNull();
    expect(svc.resolveAttachment('', '')).toBeNull();
  });

  it('同名複数候補: 参照元文書と同じフォルダを優先する', async () => {
    await mkdir(join(lib, 'A'), { recursive: true });
    await mkdir(join(lib, 'B'), { recursive: true });
    await writeFile(join(lib, 'A', '同名.png'), 'a', 'utf8');
    await writeFile(join(lib, 'B', '同名.png'), 'b', 'utf8');
    await svc.scanAll();

    expect(svc.resolveAttachment('同名.png', 'A/文書.md')).toBe('A/同名.png');
    expect(svc.resolveAttachment('同名.png', 'B/文書.md')).toBe('B/同名.png');
  });

  it('同名複数候補: 同フォルダが無ければ共通祖先が深い方を優先する', async () => {
    await mkdir(join(lib, '親', '子A'), { recursive: true });
    await mkdir(join(lib, '親', '子B'), { recursive: true });
    await writeFile(join(lib, '親', '子A', '同名2.png'), 'a', 'utf8');
    await writeFile(join(lib, '親', '子B', '同名2.png'), 'b', 'utf8');
    await svc.scanAll();

    // 参照元は「親/子A/孫/文書.md」。どちらの候補とも同フォルダではないが、
    // 親/子A(共通祖先の深さ2)の方が親/子B(深さ1)より参照元に近い
    expect(svc.resolveAttachment('同名2.png', '親/子A/孫/文書.md')).toBe('親/子A/同名2.png');
  });

  it('同名複数候補: フォルダの深さが浅い方を優先する', async () => {
    await mkdir(join(lib, '深い', 'さらに深い'), { recursive: true });
    await writeFile(join(lib, '浅い画像.png'), 'a', 'utf8');
    // ファイル名が異なると別候補になるため、同名で配置し直す
    await writeFile(join(lib, '深い', 'さらに深い', '浅い画像.png'), 'b', 'utf8');
    await svc.scanAll();

    expect(svc.resolveAttachment('浅い画像.png', '無関係/文書.md')).toBe('浅い画像.png');
  });

  it('同名複数候補: 他の優先度が全て同点なら辞書順(rel_path)で決まる', async () => {
    await mkdir(join(lib, 'X'), { recursive: true });
    await mkdir(join(lib, 'Y'), { recursive: true });
    await writeFile(join(lib, 'X', '辞書順.png'), 'a', 'utf8');
    await writeFile(join(lib, 'Y', '辞書順.png'), 'b', 'utf8');
    await svc.scanAll();

    // fromFolder=''のため同フォルダ一致なし、共通祖先の深さ・セグメント数も両者同点
    expect(svc.resolveAttachment('辞書順.png', '無関係.md')).toBe('X/辞書順.png');
  });

  it('非ASCII大文字を含むパス指定でも解決できる(SQLiteのlower()に依存しない)', async () => {
    await mkdir(join(lib, 'Bilder'), { recursive: true });
    await writeFile(join(lib, 'Bilder', 'Änderung.png'), 'x', 'utf8');
    await svc.scanAll();

    expect(svc.resolveAttachment('Bilder/Änderung.png', '')).toBe('Bilder/Änderung.png');
    expect(svc.resolveAttachment('bilder/änderung.png', '')).toBe('Bilder/Änderung.png');
  });

  it('パス指定時はヴォルトルート起点の完全パス一致を他の優先度より優先する', async () => {
    await mkdir(join(lib, 'sub'), { recursive: true });
    await mkdir(join(lib, 'A', 'sub'), { recursive: true });
    await writeFile(join(lib, 'sub', 'img.png'), 'a', 'utf8');
    await writeFile(join(lib, 'A', 'sub', 'img.png'), 'b', 'utf8');
    await svc.scanAll();

    // 参照元A/doc.mdから![[sub/img.png]]は、共通祖先の深さだけならA/sub/img.pngが
    // 優先されてしまうが、ヴォルトルート起点の完全パス一致(sub/img.png)が最優先される
    expect(svc.resolveAttachment('sub/img.png', 'A/doc.md')).toBe('sub/img.png');
  });

  it('名前のみ指定時は完全パス一致を優先せず、同フォルダを優先する(ルート直下優先のバグ防止)', async () => {
    await mkdir(join(lib, 'sub'), { recursive: true });
    await writeFile(join(lib, 'img2.png'), 'a', 'utf8'); // ルート
    await writeFile(join(lib, 'sub', 'img2.png'), 'b', 'utf8');
    await svc.scanAll();

    // 参照元sub/doc.mdからは、名前のみ指定(パスなし)なので完全パス一致は考慮せず
    // 同フォルダのsub/img2.pngが優先される
    expect(svc.resolveAttachment('img2.png', 'sub/doc.md')).toBe('sub/img2.png');
  });
});
