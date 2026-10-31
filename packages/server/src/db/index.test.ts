import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, openDatabase } from './index.js';

describe('openDatabase', () => {
  it('スキーマが作成されuser_versionが設定される', () => {
    const db = openDatabase(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);

    for (const t of ['users', 'sessions', 'locks', 'drafts', 'doc_index', 'doc_tags', 'doc_fts', 'attachment_index', 'doc_links', 'doc_props']) {
      expect(tables).toContain(t);
    }
    expect(SCHEMA_VERSION).toBe(5);
    expect(db.pragma('user_version', { simple: true })).toBe(5);
  });

  it('FTS5(trigram)で日本語全文検索ができる', () => {
    const db = openDatabase(':memory:');
    db.prepare('INSERT INTO doc_fts (doc_path, title, body) VALUES (?, ?, ?)').run(
      '設計/データモデル.md',
      'データモデル',
      'SQLiteのスキーマとインデックスの設計方針を記述する。',
    );
    db.prepare('INSERT INTO doc_fts (doc_path, title, body) VALUES (?, ?, ?)').run(
      'メモ/買い物.md',
      '買い物',
      '牛乳と卵を買う。',
    );

    const hits = db
      .prepare('SELECT doc_path FROM doc_fts WHERE doc_fts MATCH ? ORDER BY rank')
      .all('スキーマ')
      .map((r) => (r as { doc_path: string }).doc_path);

    expect(hits).toEqual(['設計/データモデル.md']);
  });

  it('同じDBファイルを再オープンしてもマイグレーションが二重実行されない', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'tsumiwiki-db-')), 'app.db');
    const db1 = openDatabase(dbPath);
    db1.prepare(
      `INSERT INTO users (username, display_name, password_hash, role, disabled, created_at, updated_at)
       VALUES ('a', 'A', 'h', 'user', 0, '2026-01-01', '2026-01-01')`,
    ).run();
    db1.close();

    // 適用済みの同一ファイルを再オープン(テーブル重複エラーが出ないこと)
    const db2 = openDatabase(dbPath);
    expect(db2.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect((db2.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1);
    db2.close();
  });

  it('v4のDBを開くとv5に上がり、doc_props が作られ doc_index.size が -1 になる', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'tsumiwiki-db-')), 'app.db');
    // v4 相当の DB を作る: 最新で作ってから doc_props を落とし user_version を 4 に戻す
    const db1 = openDatabase(dbPath);
    db1.exec('DROP TABLE doc_props');
    db1.prepare(
      "INSERT INTO doc_index (doc_path, title, folder, updated_at, size) VALUES ('a.md', 'a', '', '2026-01-01T00:00:00.000Z', 12)",
    ).run();
    db1.pragma('user_version = 4');
    db1.close();

    const db2 = openDatabase(dbPath);
    expect(db2.pragma('user_version', { simple: true })).toBe(5);
    const tables = db2
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain('doc_props');
    expect((db2.prepare("SELECT size FROM doc_index WHERE doc_path = 'a.md'").get() as { size: number }).size).toBe(-1);
    db2.close();
  });

  it('doc_props の type CHECK 制約が不正な値を拒否する', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      db
        .prepare("INSERT INTO doc_props (doc_path, key, seq, value, type) VALUES ('a.md', 'k', 0, 'v', 'bogus')")
        .run(),
    ).toThrow(/CHECK/);
  });

  it('アプリより新しいスキーマバージョンのDBは開けない(破損防止)', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'tsumiwiki-db-')), 'app.db');
    const db = openDatabase(dbPath);
    db.pragma('user_version = 99');
    db.close();

    expect(() => openDatabase(dbPath)).toThrow(/新しい/);
  });

  it('CHECK制約が不正な値を拒否する', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      db
        .prepare(
          `INSERT INTO users (username, display_name, password_hash, role, disabled, created_at, updated_at)
           VALUES ('x', 'X', 'h', 'superuser', 0, '2026-01-01', '2026-01-01')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});
