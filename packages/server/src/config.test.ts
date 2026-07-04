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
});
