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
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    disabled      INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);
  CREATE INDEX idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE locks (
    doc_path     TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    acquired_at  TEXT NOT NULL,
    refreshed_at TEXT NOT NULL
  );
  CREATE INDEX idx_locks_refreshed ON locks(refreshed_at);

  CREATE TABLE drafts (
    doc_path   TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
    source   TEXT NOT NULL CHECK (source IN ('frontmatter', 'inline')),
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
  // v2: draftsを(doc_path, user_id)の複合PKへ。
  // ロック失効後に別ユーザーが下書きを保存しても、元ユーザーの
  // 未保存内容(クラッシュ復帰用)を上書きしないため
  `
  CREATE TABLE drafts_new (
    doc_path   TEXT NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (doc_path, user_id)
  );
  INSERT INTO drafts_new SELECT doc_path, user_id, content, updated_at FROM drafts;
  DROP TABLE drafts;
  ALTER TABLE drafts_new RENAME TO drafts;
  CREATE INDEX idx_drafts_updated ON drafts(updated_at);
  `,
  // v3: 添付ファイル索引(issue #198)。![[X]]埋め込みをObsidian同様に
  // ライブラリ全体のファイル名索引で解決するため、画像等もdoc_indexと
  // 同じ方式(mtime+sizeの差分)でstatのみを索引する
  `
  CREATE TABLE attachment_index (
    rel_path   TEXT PRIMARY KEY,   -- ライブラリ相対パス(NFC、/区切り)
    name       TEXT NOT NULL,      -- ファイル名(NFC)
    name_key   TEXT NOT NULL,      -- 小文字化したファイル名(大文字小文字を区別しない検索キー)
    folder     TEXT NOT NULL,      -- 親フォルダ('' = ルート)
    updated_at TEXT NOT NULL,      -- mtime(ISO)
    size       INTEGER NOT NULL
  );
  CREATE INDEX idx_attachment_index_name ON attachment_index(name_key);
  `,
  // v4: 文書間リンク索引(issue #266)。
  // [[target]] の出現箇所を索引化し、バックリンクや未解決リンク、リネーム時の書き換えに使う。
  // 既存DBの全文書を次のscanAllで再スキャンさせるためsize = -1に更新する
  `
  CREATE TABLE doc_links (
    source_path TEXT NOT NULL,    -- リンクを含む文書(doc_index.doc_path と同じ NFC・/区切り)
    seq         INTEGER NOT NULL, -- 文書内での出現順(0始まり)。同じリンクが複数回あっても別行にする
    target_raw  TEXT NOT NULL,    -- [[ ]] 内の | より前をそのまま(書き換え・表示用)
    target_norm TEXT NOT NULL,    -- normalizeWikilinkTarget 後(#以降を除いた名前/パス)
    target_key  TEXT NOT NULL,    -- target_norm を小文字化したもの(検索キー)
    anchor      TEXT,             -- #以降(なければ NULL)
    alias       TEXT,             -- | 以降(なければ NULL)
    line        INTEGER NOT NULL, -- 本文(フロントマター除く)での行番号(1始まり)
    context     TEXT NOT NULL,    -- リンクを含む行の前後を含む抜粋(#267 の表示用。最大200文字程度)
    PRIMARY KEY (source_path, seq)
  );
  CREATE INDEX idx_doc_links_target_key ON doc_links(target_key);
  UPDATE doc_index SET size = -1;
  `,
];

// 現在のスキーマバージョン(テスト・診断用)
export const SCHEMA_VERSION = MIGRATIONS.length;

export type AppDatabase = Database.Database;

export function openDatabase(dbPath: string): AppDatabase {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // WAL下での書き込み競合時に即SQLITE_BUSYにせず待機する
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: AppDatabase): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  // 新しいアプリで作られたDBを古いアプリで開いた場合は破損防止のため起動を止める
  if (current > MIGRATIONS.length) {
    throw new Error(
      `DBのスキーマバージョン(${current})はこのアプリが対応するバージョン(${MIGRATIONS.length})より新しいため開けません`,
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
