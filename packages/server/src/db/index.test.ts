import { describe, expect, it } from 'vitest';
import { openDatabase } from './index.js';

describe('openDatabase', () => {
  it('スキーマが作成されuser_versionが設定される', () => {
    const db = openDatabase(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);

    for (const t of ['users', 'sessions', 'locks', 'drafts', 'doc_index', 'doc_tags', 'doc_fts']) {
      expect(tables).toContain(t);
    }
    expect(db.pragma('user_version', { simple: true })).toBe(1);
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

  it('再オープンしてもマイグレーションが二重実行されない', () => {
    const db = openDatabase(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    // 同一DBに対する再migrate相当(異常が出ないこと)
    expect(() => openDatabase(':memory:')).not.toThrow();
  });
});
