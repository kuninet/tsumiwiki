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
});
