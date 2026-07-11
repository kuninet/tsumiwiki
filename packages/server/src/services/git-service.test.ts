import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from './git-service';

// Git連携の検証(issue #8 / 設計06章)
// - 日本語ファイル名・フォルダ名の扱い(NFC)
// - author記録、過去版・差分(リネーム追跡は --follow の誤検出を避けるため付けない。#66)
// - 直列キューによる並行コミットの安全性
// - bareリポジトリ(バックアップ先)へのpush
// Windows実機(Git for Windows・UNCパス)での確認は別issueで行う。

const AUTHOR = { name: '山田 太郎', email: 'yamada@tsumiwiki.local' };

let lib: string;
let cleanupDirs: string[];
let svc: GitService;

beforeEach(async () => {
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-git-'));
  cleanupDirs = [lib];
  svc = new GitService(lib);
  await svc.init();
});

afterEach(async () => {
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('GitService', () => {
  it('日本語ファイル名の文書をコミットし、履歴にauthorが記録される', async () => {
    await mkdir(join(lib, '議事録'), { recursive: true });
    await writeFile(join(lib, '議事録/週次ミーティング.md'), '# 週次\n', 'utf8');
    await svc.commit(['議事録/週次ミーティング.md'], 'add: 議事録/週次ミーティング.md', AUTHOR);

    const history = await svc.history('議事録/週次ミーティング.md');
    expect(history).toHaveLength(1);
    expect(history[0].authorName).toBe('山田 太郎');
    expect(history[0].message).toBe('add: 議事録/週次ミーティング.md');

    // committerは固定のシステム名義(設計06章6.2)
    const committer = await simpleGit({ baseDir: lib }).raw(['log', '-1', '--pretty=format:%cn']);
    expect(committer).toBe('TsumiWiki');
  }, 20_000);

  it('リネーム後の新パスの履歴は「リネーム以降」のみを返す(#66)', async () => {
    // --follow は使わない方針のため、リネーム前(旧名.md)のコミットは含めない。
    // 代わりに、テンプレ由来など内容が近い別文書のコミットが誤って混入することが避けられる
    await writeFile(join(lib, '旧名.md'), '内容\n', 'utf8');
    await svc.commit(['旧名.md'], 'add: 旧名.md', AUTHOR);
    await rename(join(lib, '旧名.md'), join(lib, '新名.md'));
    await svc.commitAll('move: 旧名.md -> 新名.md', AUTHOR);

    const history = await svc.history('新名.md');
    expect(history).toHaveLength(1);
    expect(history[0].message).toBe('move: 旧名.md -> 新名.md');
  }, 20_000);

  // #66 リグレッションテスト: テンプレ由来など内容が類似した2文書があるとき、
  // 一方の履歴に他方のコミットが混入しないこと(git --follow の -M 閾値を無視した
  // 誤検出パスにハマらないよう --follow を外した)
  it('内容が類似する別文書のコミットは履歴に混入しない(#66)', async () => {
    await writeFile(join(lib, 'A.md'), '# テンプレの内容\n', 'utf8');
    await svc.commit(['A.md'], 'add: A.md', AUTHOR);
    await writeFile(join(lib, 'B.md'), '# テンプレの内容\n', 'utf8');
    await svc.commit(['B.md'], 'add: B.md', AUTHOR);
    await writeFile(join(lib, 'A.md'), '# テンプレの内容\nA固有\n', 'utf8');
    await svc.commit(['A.md'], 'edit: A.md', AUTHOR);
    await writeFile(join(lib, 'B.md'), '# テンプレの内容\nB固有\n', 'utf8');
    await svc.commit(['B.md'], 'edit: B.md', AUTHOR);

    const historyB = await svc.history('B.md');
    expect(historyB).toHaveLength(2);
    // B.md の履歴に A.md のコミット(「add: A.md」「edit: A.md」)が混入しないこと
    expect(historyB.every((h) => !h.message.includes('A.md'))).toBe(true);
    expect(historyB.map((h) => h.message).sort()).toEqual(['add: B.md', 'edit: B.md']);
  }, 20_000);

  it('過去版の内容と差分を取得できる', async () => {
    await writeFile(join(lib, 'メモ.md'), '版1\n', 'utf8');
    await svc.commit(['メモ.md'], 'add: メモ.md', AUTHOR);
    await writeFile(join(lib, 'メモ.md'), '版2\n', 'utf8');
    await svc.commit(['メモ.md'], 'edit: メモ.md', AUTHOR);

    const history = await svc.history('メモ.md');
    expect(history).toHaveLength(2);
    expect(await svc.contentAt(history[1].rev, 'メモ.md')).toBe('版1\n');

    const diff = await svc.diff(history[1].rev, history[0].rev, 'メモ.md');
    expect(diff).toContain('-版1');
    expect(diff).toContain('+版2');
  }, 20_000);

  it('並行コミットが直列化され、index.lock競合が起きない', async () => {
    const jobs = Array.from({ length: 10 }, async (_, i) => {
      const name = `並行テスト${i}.md`;
      await writeFile(join(lib, name), `内容${i}\n`, 'utf8');
      await svc.commit([name], `add: ${name}`, AUTHOR);
    });
    await Promise.all(jobs);

    const log = await simpleGit({ baseDir: lib }).log();
    // init時の.gitignoreコミット+10件
    expect(log.total).toBe(11);
  }, 30_000);

  it('外部変更(直接ファイル操作)を検知できる', async () => {
    expect(await svc.hasExternalChanges()).toBe(false);
    await writeFile(join(lib, '外部作成.md'), 'AIが直接書いた\n', 'utf8');
    expect(await svc.hasExternalChanges()).toBe(true);
    await svc.commitAll('sync: external changes', { name: 'TsumiWiki', email: 'system@tsumiwiki.local' });
    expect(await svc.hasExternalChanges()).toBe(false);
  }, 20_000);

  it('複数ファイルが変わったコミットを1エントリとして扱う(historyAll)', async () => {
    await writeFile(join(lib, 'A.md'), 'A\n', 'utf8');
    await writeFile(join(lib, 'B.md'), 'B\n', 'utf8');
    await svc.commit(['A.md', 'B.md'], 'add: A.md, B.md', AUTHOR);

    const all = await svc.historyAll();
    const entry = all.find((e) => e.message === 'add: A.md, B.md');
    expect(entry).toBeDefined();
    expect(entry?.paths.sort()).toEqual(['A.md', 'B.md']);
  }, 20_000);

  it('リネームはnew側パスのみ返す(historyAll)', async () => {
    await writeFile(join(lib, '旧.md'), '内容\n', 'utf8');
    await svc.commit(['旧.md'], 'add: 旧.md', AUTHOR);
    await rename(join(lib, '旧.md'), join(lib, '新.md'));
    await svc.commitAll('move: 旧.md -> 新.md', AUTHOR);

    const all = await svc.historyAll();
    const entry = all.find((e) => e.message === 'move: 旧.md -> 新.md');
    expect(entry).toBeDefined();
    expect(entry?.paths).toEqual(['新.md']);
  }, 20_000);

  it('limitで件数を制限できる(historyAll)', async () => {
    for (let i = 0; i < 5; i++) {
      const name = `件数${i}.md`;
      await writeFile(join(lib, name), `内容${i}\n`, 'utf8');
      await svc.commit([name], `add: ${name}`, AUTHOR);
    }

    const all = await svc.historyAll(3);
    expect(all).toHaveLength(3);
  }, 20_000);

  // #66 レビュー指摘の回帰テスト: マーカー文字列と衝突する件名・パスがあっても
  // コミットが誤分割されないこと。当実装ではマーカーをNULで挟んで衝突不能にしている
  it('件名やパスに「__C__」を含んでもコミットが誤分割されない(historyAll)', async () => {
    await writeFile(join(lib, '通常.md'), '内容\n', 'utf8');
    await svc.commit(['通常.md'], '__C__を含む件名のコミット', AUTHOR);

    await writeFile(join(lib, 'path__C__inside.md'), '内容\n', 'utf8');
    await svc.commit(['path__C__inside.md'], 'add: path__C__inside.md', AUTHOR);

    const all = await svc.historyAll();
    const withMarkerMessage = all.find((e) => e.message === '__C__を含む件名のコミット');
    expect(withMarkerMessage).toBeDefined();
    expect(withMarkerMessage?.paths).toEqual(['通常.md']);

    const withMarkerPath = all.find((e) => e.message === 'add: path__C__inside.md');
    expect(withMarkerPath).toBeDefined();
    expect(withMarkerPath?.paths).toEqual(['path__C__inside.md']);
  }, 20_000);

  it('bareリポジトリへバックアップpushできる', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'tsumiwiki-bare-'));
    cleanupDirs.push(bare);
    await simpleGit({ baseDir: bare }).init(true);

    await writeFile(join(lib, 'バックアップ対象.md'), 'x\n', 'utf8');
    await svc.commit(['バックアップ対象.md'], 'add: バックアップ対象.md', AUTHOR);
    await svc.pushBackup(bare);

    const out = await simpleGit({ baseDir: bare }).raw(['log', '--pretty=format:%s', 'main']);
    expect(out).toContain('add: バックアップ対象.md');

    // 2回目のpush(継続バックアップ)も成功する
    await writeFile(join(lib, 'バックアップ対象.md'), 'y\n', 'utf8');
    await svc.commit(['バックアップ対象.md'], 'edit: バックアップ対象.md', AUTHOR);
    await svc.pushBackup(bare);
    const out2 = await simpleGit({ baseDir: bare }).raw(['log', '--pretty=format:%s', 'main']);
    expect(out2).toContain('edit: バックアップ対象.md');
  }, 30_000);
});
