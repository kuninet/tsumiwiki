import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../db/index.js';
import { backlinkTargetKeys, IndexerService } from './indexer-service.js';

describe('backlinkTargetKeys', () => {
  it('ルート直下の文書キーを生成する', () => {
    const keys = backlinkTargetKeys('Doc.md', 'Doc');
    expect(keys).toContain('doc');
    expect(keys).toHaveLength(1);
  });

  it('1階層フォルダ直下の文書キーを生成する', () => {
    const keys = backlinkTargetKeys('folder/Doc.md', 'Doc');
    expect(keys).toContain('doc');
    expect(keys).toContain('folder/doc');
    expect(keys).toHaveLength(2);
  });

  it('多階層フォルダの文書キーを末尾部分パス含めて生成する', () => {
    const keys = backlinkTargetKeys('a/b/c/Doc.md', 'Doc');
    expect(keys).toContain('doc');
    expect(keys).toContain('a/b/c/doc');
    expect(keys).toContain('b/c/doc');
    expect(keys).toContain('c/doc');
    expect(keys).toHaveLength(4);
  });

  it('日本語および大文字小文字をNFC・小文字化して生成する', () => {
    const keys = backlinkTargetKeys('プロジェクト/機能A.md', '機能A');
    expect(keys).toContain('機能a');
    expect(keys).toContain('プロジェクト/機能a');
  });

  it('titleが省略された場合はパスのbasenameから補完する', () => {
    const keys = backlinkTargetKeys('sub/Doc.md');
    expect(keys).toContain('doc');
    expect(keys).toContain('sub/doc');
  });
});

describe('IndexerService.findBacklinks', () => {
  let lib: string;
  let db: AppDatabase;
  let svc: IndexerService;

  beforeEach(async () => {
    lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-backlinks-'));
    db = openDatabase(':memory:');
    svc = new IndexerService(db, lib);
  });

  afterEach(async () => {
    db.close();
    await rm(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('様々な記法([[T]], [[フォルダ/T]], [[T#見出し]], [[T|別名]], 大文字小文字)で参照されたリンクを検出する', async () => {
    await mkdir(join(lib, 'folder'), { recursive: true });
    // 対象文書
    await writeFile(join(lib, 'folder/Target.md'), '# Target\n本文\n', 'utf8');

    // 参照元1: タイトル参照
    await writeFile(join(lib, 'Ref1.md'), 'Ref1から [[Target]] へのリンク\n', 'utf8');
    // 参照元2: フォルダパス参照
    await writeFile(join(lib, 'Ref2.md'), 'Ref2から [[folder/Target]] へのリンク\n', 'utf8');
    // 参照元3: 見出し付き参照
    await writeFile(join(lib, 'Ref3.md'), 'Ref3から [[Target#見出し]] へのリンク\n', 'utf8');
    // 参照元4: 別名付き参照
    await writeFile(join(lib, 'Ref4.md'), 'Ref4から [[Target|別名表示]] へのリンク\n', 'utf8');
    // 参照元5: 小文字参照
    await writeFile(join(lib, 'Ref5.md'), 'Ref5から [[target]] へのリンク\n', 'utf8');

    await svc.scanAll();

    const result = svc.findBacklinks('folder/Target.md');
    expect(result.truncated).toBe(false);
    expect(result.backlinks).toHaveLength(5);

    const paths = result.backlinks.map((b) => b.sourcePath).sort();
    expect(paths).toEqual(['Ref1.md', 'Ref2.md', 'Ref3.md', 'Ref4.md', 'Ref5.md']);

    // 各リンクの詳細確認
    const ref3 = result.backlinks.find((b) => b.sourcePath === 'Ref3.md')!;
    expect(ref3.links[0].anchor).toBe('見出し');

    const ref4 = result.backlinks.find((b) => b.sourcePath === 'Ref4.md')!;
    expect(ref4.links[0].alias).toBe('別名表示');
  });

  it('同名の文書 a/T.md と b/T.md があるとき、リゾルバの解決先と一致する文書のみバックリンクに含まれる', async () => {
    await mkdir(join(lib, 'a'), { recursive: true });
    await mkdir(join(lib, 'b'), { recursive: true });

    await writeFile(join(lib, 'a/T.md'), '# T in a\n', 'utf8');
    await writeFile(join(lib, 'b/T.md'), '# T in b\n', 'utf8');

    // RefA: [[T]] -> 辞書順で a/T.md に解決される
    await writeFile(join(lib, 'RefA.md'), '[[T]]\n', 'utf8');
    // RefB: [[b/T]] -> パス指定で b/T.md に解決される
    await writeFile(join(lib, 'RefB.md'), '[[b/T]]\n', 'utf8');

    await svc.scanAll();

    // a/T.md のバックリンクには RefA のみ
    const resA = svc.findBacklinks('a/T.md');
    expect(resA.backlinks.map((b) => b.sourcePath)).toEqual(['RefA.md']);

    // b/T.md のバックリンクには RefB のみ
    const resB = svc.findBacklinks('b/T.md');
    expect(resB.backlinks.map((b) => b.sourcePath)).toEqual(['RefB.md']);
  });

  it('コードブロックやインラインコード内の [[T]] はバックリンクに含まれない', async () => {
    await writeFile(join(lib, 'Target.md'), '# Target\n', 'utf8');
    await writeFile(
      join(lib, 'CodeRef.md'),
      '```markdown\n[[Target]]\n```\nインライン: `[[Target]]`\n画像埋め込み: ![[Target]]\n',
      'utf8',
    );

    await svc.scanAll();

    const res = svc.findBacklinks('Target.md');
    expect(res.backlinks).toHaveLength(0);
  });

  it('自分自身へのリンクはバックリンクから除外される', async () => {
    await writeFile(join(lib, 'Self.md'), '# Self\n自己リンク: [[Self]]\n', 'utf8');
    await svc.scanAll();

    const res = svc.findBacklinks('Self.md');
    expect(res.backlinks).toHaveLength(0);
  });

  it('1つの参照元に複数のリンクがある場合、1項目内にseq順で複数の抜粋が並ぶ', async () => {
    await writeFile(join(lib, 'Target.md'), '# Target\n', 'utf8');
    await writeFile(
      join(lib, 'MultiRef.md'),
      '1行目: [[Target]] リンク\n2行目は何もない\n3行目: 再度 [[Target|別名]] リンク\n',
      'utf8',
    );

    await svc.scanAll();

    const res = svc.findBacklinks('Target.md');
    expect(res.backlinks).toHaveLength(1);
    const entry = res.backlinks[0];
    expect(entry.sourcePath).toBe('MultiRef.md');
    expect(entry.links).toHaveLength(2);
    expect(entry.links[0].line).toBe(1);
    expect(entry.links[0].alias).toBeNull();
    expect(entry.links[1].line).toBe(3);
    expect(entry.links[1].alias).toBe('別名');
  });

  it('リンクが0件の場合は空配列と truncated: false を返す', async () => {
    await writeFile(join(lib, 'Alone.md'), '# Alone\n誰もリンクしていない\n', 'utf8');
    await svc.scanAll();

    const res = svc.findBacklinks('Alone.md');
    expect(res.backlinks).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  it('上限(limit)を超えた場合はtruncated: trueとなり上限件数にスライスされる', async () => {
    await writeFile(join(lib, 'Target.md'), '# Target\n', 'utf8');

    for (let i = 1; i <= 5; i++) {
      await writeFile(join(lib, `Ref${i}.md`), `[[Target]]\n`, 'utf8');
    }

    await svc.scanAll();

    // limit: 3 でテスト
    const res = svc.findBacklinks('Target.md', { limit: 3 });
    expect(res.truncated).toBe(true);
    expect(res.backlinks).toHaveLength(3);
  });
});
