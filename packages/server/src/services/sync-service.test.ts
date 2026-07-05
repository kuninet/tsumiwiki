import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/index.js';
import { BackupService } from './backup-service.js';
import { GitService } from './git-service.js';
import { IndexerService } from './indexer-service.js';
import { LibraryWatcher } from './library-watcher.js';
import { SyncService } from './sync-service.js';

// 外部変更取り込み・バックアップpushのテスト(FR-DOC-08 / NFR-AVL-02)

let lib: string;
let cleanup: string[];
let git: GitService;
let indexer: IndexerService;
let sync: SyncService;

beforeEach(async () => {
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-sync-'));
  cleanup = [lib];
  git = new GitService(lib);
  await git.init();
  const db = openDatabase(':memory:');
  indexer = new IndexerService(db, lib);
  sync = new SyncService(git, indexer);
});

afterEach(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('SyncService', () => {
  it('外部で書かれたファイルをsyncコミットとして取り込み、索引に反映する', async () => {
    await writeFile(join(lib, 'AIが書いた.md'), '外部エージェントの成果物 #自動生成\n', 'utf8');

    const result = await sync.run();
    expect(result.committed).toBe(true);
    expect(result.indexed).toBe(1);

    // authorはシステム名義(FR-DOC-06を汚さない)
    const log = await simpleGit({ baseDir: lib }).log();
    expect(log.latest?.message).toBe('sync: external changes');
    expect(log.latest?.author_name).toBe('TsumiWiki');
  }, 30_000);

  it('変更がなければコミットしない(冪等)', async () => {
    await writeFile(join(lib, 'x.md'), 'a\n', 'utf8');
    await sync.run();
    const second = await sync.run();
    expect(second.committed).toBe(false);
    expect(second.indexed).toBe(0);

    const log = await simpleGit({ baseDir: lib }).log();
    // init時の.gitignoreコミット+syncコミット1件
    expect(log.total).toBe(2);
  }, 30_000);

  it('外部での削除も取り込まれ、索引から消える', async () => {
    await writeFile(join(lib, '消される.md'), 'a\n', 'utf8');
    await sync.run();
    await rm(join(lib, '消される.md'));

    const result = await sync.run();
    expect(result.committed).toBe(true);
    expect(result.removed).toBe(1);
  }, 30_000);
});

describe('LibraryWatcher', () => {
  it('ファイル変更をデバウンスして通知する', async () => {
    const onChange = vi.fn();
    const watcher = new LibraryWatcher(lib, onChange, 200);
    watcher.start();
    // chokidarの初期化を待つ
    await new Promise((r) => setTimeout(r, 500));

    await writeFile(join(lib, '監視対象.md'), 'a\n', 'utf8');
    await writeFile(join(lib, '監視対象2.md'), 'b\n', 'utf8');
    await new Promise((r) => setTimeout(r, 1500));

    expect(onChange).toHaveBeenCalled();
    // デバウンスにより連続変更が1回にまとまる(厳密に1回とは限らないが過剰でない)
    expect(onChange.mock.calls.length).toBeLessThanOrEqual(2);
    await watcher.stop();
  }, 30_000);

  it('.git配下の変更は通知しない', async () => {
    const onChange = vi.fn();
    const watcher = new LibraryWatcher(lib, onChange, 200);
    watcher.start();
    await new Promise((r) => setTimeout(r, 500));

    await writeFile(join(lib, '.git', 'test-marker'), 'x\n', 'utf8');
    await new Promise((r) => setTimeout(r, 1000));

    expect(onChange).not.toHaveBeenCalled();
    await watcher.stop();
  }, 30_000);
});

describe('BackupService', () => {
  it('bareリポジトリへpushし、状態がhealthに反映できる形で残る', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'tsumiwiki-syncbare-'));
    cleanup.push(bare);
    await simpleGit({ baseDir: bare }).init(true);
    await writeFile(join(lib, 'x.md'), 'a\n', 'utf8');
    await sync.run();

    const backup = new BackupService(git, bare);
    expect(await backup.pushNow()).toBe(true);
    const status = backup.status();
    expect(status.configured).toBe(true);
    expect(status.lastSuccessAt).toBeTruthy();
    expect(status.lastError).toBeNull();
  }, 30_000);

  it('push失敗時はエラーを記録し、falseを返す(本体は落ちない)', async () => {
    await writeFile(join(lib, 'x.md'), 'a\n', 'utf8');
    await sync.run();

    const backup = new BackupService(git, '/存在しない/リモート/repo.git');
    expect(await backup.pushNow()).toBe(false);
    expect(backup.status().lastError).toBeTruthy();
  }, 30_000);

  it('未設定ならpushNowは何もしない', async () => {
    const backup = new BackupService(git, null);
    expect(await backup.pushNow()).toBe(false);
    expect(backup.status().configured).toBe(false);
  }, 20_000);
});

describe('レビュー指摘の回帰テスト', () => {
  it('アトミック書き込みの一時ファイルはsyncコミットに巻き込まれない(.gitignore)', async () => {
    await writeFile(join(lib, '.tsumiwiki-tmp-abc123'), '書き込み途中\n', 'utf8');
    const result = await sync.run();
    expect(result.committed).toBe(false);

    const status = await simpleGit({ baseDir: lib }).status();
    expect(status.isClean()).toBe(true); // ignoredなので未追跡にも出ない
    await rm(join(lib, '.tsumiwiki-tmp-abc123'), { force: true });
  }, 30_000);

  it('syncの並行呼び出しは直列化され、コミットは1件だけ積まれる', async () => {
    await writeFile(join(lib, '並行対象.md'), 'x\n', 'utf8');
    await Promise.all([sync.run(), sync.run(), sync.run(), sync.run(), sync.run()]);

    const log = await simpleGit({ baseDir: lib }).log();
    // .gitignore + sync 1件のみ(多重syncコミットなし)
    expect(log.total).toBe(2);
  }, 30_000);

  it('watcherは.obsidianを無視し.trashは通知する', async () => {
    const { mkdir } = await import('node:fs/promises');
    const onChange = vi.fn();
    const watcher = new LibraryWatcher(lib, onChange, 200);
    watcher.start();
    await new Promise((r) => setTimeout(r, 500));

    await mkdir(join(lib, '.obsidian'), { recursive: true });
    await writeFile(join(lib, '.obsidian', 'app.json'), '{}', 'utf8');
    await new Promise((r) => setTimeout(r, 800));
    expect(onChange).not.toHaveBeenCalled();

    await mkdir(join(lib, '.trash'), { recursive: true });
    await writeFile(join(lib, '.trash', '外部削除.md'), 'x\n', 'utf8');
    await new Promise((r) => setTimeout(r, 1200));
    expect(onChange).toHaveBeenCalled();
    await watcher.stop();
  }, 30_000);

  it('pushのタイムアウトが失敗として記録される(本体は継続)', async () => {
    const hangingGit = {
      pushBackup: () => new Promise<void>(() => {}),
    } as unknown as GitService;
    const backup = new BackupService(hangingGit, '/dummy/remote.git', undefined, 300);
    expect(await backup.pushNow()).toBe(false);
    expect(backup.status().lastError).toContain('タイムアウト');
  }, 20_000);

  it('未認証のhealthにはバックアップ詳細(lastError)が含まれない', async () => {
    const { buildApp } = await import('../app.js');
    const { loadConfig } = await import('../config.js');
    const config = loadConfig({ LIBRARY_PATH: lib, BACKUP_REMOTE: '/存在しない/remote.git' });
    const db = openDatabase(':memory:');
    const app = buildApp({ config, db, logger: false });
    await app.ready();
    await app.backupService.pushNow(); // 失敗してlastErrorが記録される

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().backup.configured).toBe(true);
    expect(health.json().backup.healthy).toBe(false);
    expect(JSON.stringify(health.json())).not.toContain('存在しない');
    await app.close();
  }, 30_000);
});
