import pino from 'pino';
import type { AppConfig } from './config';

// 構造化ログ(NFR-OPS-03)。LOG_FILE指定時はファイルへ、未指定時は標準出力へ。
// ローテーションはOS側(logrotate / Windowsタスク)で行う想定。
// MCPのBearerトークンをログに残さない(issue #190)
const REDACT = { paths: ['req.headers.authorization', 'headers.authorization'], censor: '[REDACTED]' };

export function createLogger(config: Pick<AppConfig, 'logLevel' | 'logFile'>): pino.Logger {
  if (config.logFile) {
    return pino(
      { level: config.logLevel, redact: REDACT },
      pino.destination({ dest: config.logFile, mkdir: true }),
    );
  }
  return pino({ level: config.logLevel, redact: REDACT });
}
