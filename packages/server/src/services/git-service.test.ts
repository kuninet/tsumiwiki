import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from './git-service';

// Git連携の検証(issue #8 / 設計06章)
// - 日本語ファイル名・フォルダ名の扱い(NFC)
// - author記録、--followによるリネーム追跡、過去版・差分
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
    await rm(dir, { recursive: true, force: true });
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
    const committer = await simpleGit({ baseDir: lib }).raw(['log', '--pretty=format:%cn']);
    expect(committer).toBe('TsumiWiki');
  }, 20_000);

  it('リネームを--followで追跡できる', async () => {
    await writeFile(join(lib, '旧名.md'), '内容\n', 'utf8');
    await svc.commit(['旧名.md'], 'add: 旧名.md', AUTHOR);
    await rename(join(lib, '旧名.md'), join(lib, '新名.md'));
    await svc.commitAll('move: 旧名.md -> 新名.md', AUTHOR);

    const history = await svc.history('新名.md');
    expect(history).toHaveLength(2);
    expect(history[0].message).toBe('move: 旧名.md -> 新名.md');
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
    expect(log.total).toBe(10);
  }, 30_000);

  it('外部変更(直接ファイル操作)を検知できる', async () => {
    expect(await svc.hasExternalChanges()).toBe(false);
    await writeFile(join(lib, '外部作成.md'), 'AIが直接書いた\n', 'utf8');
    expect(await svc.hasExternalChanges()).toBe(true);
    await svc.commitAll('sync: external changes', { name: 'TsumiWiki', email: 'system@tsumiwiki.local' });
    expect(await svc.hasExternalChanges()).toBe(false);
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
