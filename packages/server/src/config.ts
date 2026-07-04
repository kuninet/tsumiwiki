import path from 'node:path';

// アプリ設定(設計01章1.4)。環境変数から読み込む。

export interface AppConfig {
  libraryPath: string;
  port: number;
  host: string;
  dbPath: string;
  sessionTtlMinutes: number;
  lockTimeoutMinutes: number;
  attachmentDirMode: string; // 'same-folder' | フォルダ名
  backupRemote: string | null;
  backupPushIntervalMinutes: number;
  maxUploadMb: number;
  logLevel: string;
  logFile: string | null;
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

function intOf(value: string | undefined, fallback: number, name: string, max?: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || (max !== undefined && n > max)) {
    throw new Error(
      `設定 ${name} は正の整数${max !== undefined ? `(最大${max})` : ''}で指定してください: ${value}`,
    );
  }
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const libraryPathRaw = env.LIBRARY_PATH;
  if (!libraryPathRaw) {
    throw new Error('環境変数 LIBRARY_PATH(ライブラリフォルダのパス)は必須です');
  }
  const libraryPath = path.resolve(libraryPathRaw);

  // 既定のDB置き場はcwdに依存させない(サービス起動時のWorkingDirectory差異で
  // 別のDBを開いてしまう事故を防ぐ)。ライブラリの隣の tsumiwiki-data に置く
  const dbPath = env.DB_PATH
    ? path.resolve(env.DB_PATH)
    : path.resolve(libraryPath, '..', 'tsumiwiki-data', 'app.db');
  if (dbPath === libraryPath || dbPath.startsWith(libraryPath + path.sep)) {
    throw new Error(
      'DB_PATH はライブラリフォルダ(LIBRARY_PATH)の外に配置してください(インデックス走査・Gitコミットの対象になってしまうため)',
    );
  }

  // 添付保存先はトラバーサル源にならないよう限定する(FR-OBS-05)
  const attachmentDirMode = env.ATTACHMENT_DIR_MODE ?? 'same-folder';
  if (attachmentDirMode !== 'same-folder') {
    const isSafeFolderName =
      /^[^/\\]+$/.test(attachmentDirMode) &&
      !attachmentDirMode.startsWith('.') &&
      !/[\u0000-\u001f\u007f]/.test(attachmentDirMode);
    if (!isSafeFolderName) {
      throw new Error(
        'ATTACHMENT_DIR_MODE は "same-folder" または単一のフォルダ名(区切り・ドット始まり不可)で指定してください',
      );
    }
  }

  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`LOG_LEVEL は ${LOG_LEVELS.join(' / ')} のいずれかで指定してください: ${logLevel}`);
  }

  return {
    libraryPath,
    port: intOf(env.PORT, 3000, 'PORT', 65535),
    host: env.HOST ?? '0.0.0.0',
    dbPath,
    sessionTtlMinutes: intOf(env.SESSION_TTL_MINUTES, 480, 'SESSION_TTL_MINUTES'),
    lockTimeoutMinutes: intOf(env.LOCK_TIMEOUT_MINUTES, 30, 'LOCK_TIMEOUT_MINUTES'),
    attachmentDirMode,
    backupRemote: env.BACKUP_REMOTE ?? null,
    backupPushIntervalMinutes: intOf(
      env.BACKUP_PUSH_INTERVAL_MINUTES,
      10,
      'BACKUP_PUSH_INTERVAL_MINUTES',
    ),
    maxUploadMb: intOf(env.MAX_UPLOAD_MB, 20, 'MAX_UPLOAD_MB', 1024),
    logLevel,
    logFile: env.LOG_FILE ?? null,
  };
}
