import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('LIBRARY_PATHがないとエラーになる', () => {
    expect(() => loadConfig({})).toThrow(/LIBRARY_PATH/);
  });

  it('既定値が適用される', () => {
    const config = loadConfig({ LIBRARY_PATH: '/tmp/lib' });
    expect(config.port).toBe(3000);
    expect(config.sessionTtlMinutes).toBe(480);
    expect(config.lockTimeoutMinutes).toBe(30);
    expect(config.attachmentDirMode).toBe('same-folder');
    expect(config.backupRemote).toBeNull();
    expect(config.backupPushIntervalMinutes).toBe(10);
  });

  it('環境変数で上書きできる', () => {
    const config = loadConfig({
      LIBRARY_PATH: '/tmp/lib',
      PORT: '8080',
      LOCK_TIMEOUT_MINUTES: '15',
      BACKUP_REMOTE: '\\\\fileserver\\share\\tsumiwiki.git',
    });
    expect(config.port).toBe(8080);
    expect(config.lockTimeoutMinutes).toBe(15);
    expect(config.backupRemote).toBe('\\\\fileserver\\share\\tsumiwiki.git');
  });

  it('数値でない設定はエラーになる', () => {
    expect(() => loadConfig({ LIBRARY_PATH: '/tmp/lib', PORT: 'abc' })).toThrow(/PORT/);
  });

  it('PORTの上限(65535)を超えるとエラーになる', () => {
    expect(() => loadConfig({ LIBRARY_PATH: '/tmp/lib', PORT: '70000' })).toThrow(/PORT/);
  });

  it('既定のDB_PATHはcwd非依存でライブラリの隣に置かれる', () => {
    const config = loadConfig({ LIBRARY_PATH: '/tmp/wiki/library' });
    expect(config.dbPath).toBe('/tmp/wiki/tsumiwiki-data/app.db');
  });

  it('DB_PATHがライブラリ配下だとエラーになる', () => {
    expect(() =>
      loadConfig({ LIBRARY_PATH: '/tmp/lib', DB_PATH: '/tmp/lib/data/app.db' }),
    ).toThrow(/DB_PATH/);
  });

  it('ATTACHMENT_DIR_MODEに不正なフォルダ名を指定するとエラーになる', () => {
    for (const bad of ['../attach', 'a/b', '.hidden', 'a\\b']) {
      expect(() => loadConfig({ LIBRARY_PATH: '/tmp/lib', ATTACHMENT_DIR_MODE: bad })).toThrow(
        /ATTACHMENT_DIR_MODE/,
      );
    }
    expect(loadConfig({ LIBRARY_PATH: '/tmp/lib', ATTACHMENT_DIR_MODE: 'attachments' }).attachmentDirMode).toBe(
      'attachments',
    );
  });

  it('不正なLOG_LEVELはエラーになる', () => {
    expect(() => loadConfig({ LIBRARY_PATH: '/tmp/lib', LOG_LEVEL: 'verbose' })).toThrow(
      /LOG_LEVEL/,
    );
  });
});
