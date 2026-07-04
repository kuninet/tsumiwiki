import path from 'node:path';

// アプリ設定(設計01章1.4)。環境変数から読み込む。

export interface AppConfig {
  libraryPath: string;
  port: number;
  dbPath: string;
  sessionTtlMinutes: number;
  lockTimeoutMinutes: number;
  attachmentDirMode: string; // 'same-folder' | フォルダ名
  backupRemote: string | null;
  backupPushIntervalMinutes: number;
  logLevel: string;
  logFile: string | null;
}

function intOf(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`設定 ${name} は正の整数で指定してください: ${value}`);
  }
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const libraryPath = env.LIBRARY_PATH;
  if (!libraryPath) {
    throw new Error('環境変数 LIBRARY_PATH(ライブラリフォルダのパス)は必須です');
  }
  return {
    libraryPath: path.resolve(libraryPath),
    port: intOf(env.PORT, 3000, 'PORT'),
    dbPath: env.DB_PATH ? path.resolve(env.DB_PATH) : path.resolve('data', 'app.db'),
    sessionTtlMinutes: intOf(env.SESSION_TTL_MINUTES, 480, 'SESSION_TTL_MINUTES'),
    lockTimeoutMinutes: intOf(env.LOCK_TIMEOUT_MINUTES, 30, 'LOCK_TIMEOUT_MINUTES'),
    attachmentDirMode: env.ATTACHMENT_DIR_MODE ?? 'same-folder',
    backupRemote: env.BACKUP_REMOTE ?? null,
    backupPushIntervalMinutes: intOf(
      env.BACKUP_PUSH_INTERVAL_MINUTES,
      10,
      'BACKUP_PUSH_INTERVAL_MINUTES',
    ),
    logLevel: env.LOG_LEVEL ?? 'info',
    logFile: env.LOG_FILE ?? null,
  };
}
