import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIBRARY_SETTINGS_DEFAULTS } from '@tsumiwiki/shared';
import { GitService } from './git-service.js';
import { LibrarySettingsService } from './library-settings-service.js';

// #99: settings.yaml のパース/バリデーション失敗をサイレントに握って
//      デフォルト値へフォールバックすると、admin がそれと気付かず保存し
//      git上の正しい過去版を上書きしてしまう事故が起きる。
//      get() が corrupted フラグを正しく返すこと・warn ログを出すことを検証する。

let lib: string;
let svc: LibrarySettingsService;
let warn: ReturnType<typeof vi.fn>;
let logger: Logger;

function settingsPath() {
  return join(lib, '.tsumiwiki/settings.yaml');
}

beforeEach(async () => {
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-libset-svc-'));
  warn = vi.fn();
  logger = { warn } as unknown as Logger;
  svc = new LibrarySettingsService(lib, new GitService(lib), logger);
});

afterEach(async () => {
  await rm(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('LibrarySettingsService#get', () => {
  it('ファイル不在: デフォルト値を返し、corruptedはfalse(初期セットアップ扱い)', async () => {
    const result = await svc.get();
    expect(result.settings).toEqual(LIBRARY_SETTINGS_DEFAULTS);
    expect(result.corrupted).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('不正なYAML(パース失敗): デフォルト値+corrupted trueを返し、warnログを出す', async () => {
    await mkdir(join(lib, '.tsumiwiki'), { recursive: true });
    await writeFile(settingsPath(), 'templates: [unterminated\n', 'utf8');

    const result = await svc.get();
    expect(result.settings).toEqual(LIBRARY_SETTINGS_DEFAULTS);
    expect(result.corrupted).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('スキーマ違反(パースは通るがvalidation失敗): デフォルト値+corrupted trueを返し、warnログを出す', async () => {
    await mkdir(join(lib, '.tsumiwiki'), { recursive: true });
    await writeFile(
      settingsPath(),
      'templates:\n  folder: _templates\ndailyNotes:\n  folder: 日記\n  template: ""\n  filenamePattern: 123\n',
      'utf8',
    );

    const result = await svc.get();
    expect(result.settings).toEqual(LIBRARY_SETTINGS_DEFAULTS);
    expect(result.corrupted).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('正常なYAML: パースした値を返し、corruptedはfalse', async () => {
    await mkdir(join(lib, '.tsumiwiki'), { recursive: true });
    await writeFile(
      settingsPath(),
      'templates:\n  folder: テンプレ\ndailyNotes:\n  folder: 日々\n  template: ""\n  filenamePattern: YYYY-MM-DD\n',
      'utf8',
    );

    const result = await svc.get();
    expect(result.corrupted).toBe(false);
    expect(result.settings.templates.folder).toBe('テンプレ');
    expect(warn).not.toHaveBeenCalled();
  });

  it('loggerを渡さなくてもエラーにならない(オプショナル)', async () => {
    const noLoggerSvc = new LibrarySettingsService(lib, new GitService(lib));
    await mkdir(join(lib, '.tsumiwiki'), { recursive: true });
    await writeFile(settingsPath(), 'templates: [unterminated\n', 'utf8');

    const result = await noLoggerSvc.get();
    expect(result.corrupted).toBe(true);
  });

  it('ファイル不在かつ defaultAttachmentDirMode 指定時: 環境変数互換の vault-folder が返る', async () => {
    const envSvc = new LibrarySettingsService(lib, new GitService(lib), logger, 'assets');
    const result = await envSvc.get();
    expect(result.corrupted).toBe(false);
    expect(result.settings.attachments).toEqual({ mode: 'vault-folder', folder: 'assets' });
  });

  it('attachments キーが無い既存 YAML: defaultAttachmentDirMode の値へフォールバックする', async () => {
    await mkdir(join(lib, '.tsumiwiki'), { recursive: true });
    await writeFile(
      settingsPath(),
      'templates:\n  folder: _templates\ndailyNotes:\n  folder: 日記\n  template: ""\n  filenamePattern: YYYY-MM-DD\n',
      'utf8',
    );
    const envSvc = new LibrarySettingsService(lib, new GitService(lib), logger, 'assets');
    const result = await envSvc.get();
    expect(result.corrupted).toBe(false);
    expect(result.settings.attachments).toEqual({ mode: 'vault-folder', folder: 'assets' });
  });

  it('attachments キーが不正な場合は corrupted: true となる', async () => {
    await mkdir(join(lib, '.tsumiwiki'), { recursive: true });
    await writeFile(
      settingsPath(),
      'templates:\n  folder: _templates\ndailyNotes:\n  folder: 日記\n  template: ""\n  filenamePattern: YYYY-MM-DD\nattachments:\n  mode: invalid-mode\n  folder: attachments\n',
      'utf8',
    );
    const envSvc = new LibrarySettingsService(lib, new GitService(lib), logger, 'assets');
    const result = await envSvc.get();
    expect(result.corrupted).toBe(true);
    expect(result.settings.attachments).toEqual({ mode: 'vault-folder', folder: 'assets' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('settings.yaml の attachments は環境変数フォールバックより優先される', async () => {
    const git = new GitService(lib);
    await git.init();
    const envSvc = new LibrarySettingsService(lib, git, logger, 'assets');
    await envSvc.update(
      {
        ...LIBRARY_SETTINGS_DEFAULTS,
        attachments: { mode: 'doc-subfolder', folder: 'media/' },
      },
      { name: 'admin', email: 'admin@example.com' },
    );
    const result = await envSvc.get();
    expect(result.corrupted).toBe(false);
    expect(result.settings.attachments).toEqual({ mode: 'doc-subfolder', folder: 'media' });
  });
});
