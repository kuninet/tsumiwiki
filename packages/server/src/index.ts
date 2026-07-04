import { mkdirSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config);

mkdirSync(config.libraryPath, { recursive: true });
const db = openDatabase(config.dbPath);

const app = buildApp({ config, db, logger });

app.listen({ port: config.port, host: '0.0.0.0' }).catch((err) => {
  logger.error(err, 'サーバー起動に失敗しました');
  process.exit(1);
});
