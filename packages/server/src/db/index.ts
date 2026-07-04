import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// SQLiteスキーマ(設計02章2.2)。
// SQLite側は「ライブラリから再構築可能なキャッシュ」または
// 「文書と独立した運用データ」のみを持つ。

const MIGRATIONS: string[] = [
  // v1: 初期スキーマ
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE locks (
    doc_path     TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    acquired_at  TEXT NOT NULL,
    refreshed_at TEXT NOT NULL
  );

  CREATE TABLE drafts (
    doc_path   TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    content    TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE doc_index (
    doc_path   TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    folder     TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    size       INTEGER NOT NULL
  );

  CREATE TABLE doc_tags (
    doc_path TEXT NOT NULL,
    tag      TEXT NOT NULL,
    source   TEXT NOT NULL,
    PRIMARY KEY (doc_path, tag, source)
  );
  CREATE INDEX idx_doc_tags_tag ON doc_tags(tag);

  CREATE VIRTUAL TABLE doc_fts USING fts5(
    doc_path UNINDEXED,
    title,
    body,
    tokenize = 'trigram'
  );
  `,
];

export type AppDatabase = Database.Database;

export function openDatabase(dbPath: string): AppDatabase {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: AppDatabase): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
