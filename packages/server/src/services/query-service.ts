import type { DocSummary, SearchResult, TagCount } from '@tsumiwiki/shared';
import type { AppDatabase } from '../db/index.js';

// 検索・タグ・最近更新の読み取り系クエリ(FR-NAV-02/03/04)
// すべてインデックス(doc_index / doc_tags / doc_fts)に対する参照のみ

interface DocRow {
  doc_path: string;
  title: string;
  folder: string;
  updated_at: string;
}

function toSummary(row: DocRow): DocSummary {
  return { path: row.doc_path, title: row.title, folder: row.folder, updatedAt: row.updated_at };
}

// FTS5クエリ構文([" * ( ] 等)をユーザー入力から無効化する。
// 空白区切りの各語をダブルクォートで包む(暗黙AND)。内部の"は二重化
function toFtsQuery(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' ');
}

export class QueryService {
  constructor(private readonly db: AppDatabase) {}

  // 全文検索(FR-NAV-03)。snippetはヒット箇所前後をハイライト付きで返す
  search(q: string, limit = 50): SearchResult[] {
    const ftsQuery = toFtsQuery(q);
    if (!ftsQuery) return [];
    const rows = this.db
      .prepare(
        `SELECT f.doc_path, f.title,
                snippet(doc_fts, 2, '<mark>', '</mark>', '…', 20) AS snip
         FROM doc_fts f
         WHERE doc_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as { doc_path: string; title: string; snip: string }[];
    return rows.map((r) => ({ path: r.doc_path, title: r.title, snippet: r.snip }));
  }

  // タグ一覧(件数つき。FR-NAV-02)。同一文書の frontmatter/inline 重複は1件と数える
  tags(): TagCount[] {
    return this.db
      .prepare(
        `SELECT tag, COUNT(DISTINCT doc_path) AS count
         FROM doc_tags GROUP BY tag
         ORDER BY count DESC, tag`,
      )
      .all() as TagCount[];
  }

  // 指定タグを全て持つ文書(AND絞り込み。FR-NAV-02)
  docsByTags(tags: string[]): DocSummary[] {
    if (tags.length === 0) return [];
    const placeholders = tags.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT i.doc_path, i.title, i.folder, i.updated_at
         FROM doc_index i
         WHERE i.doc_path IN (
           SELECT doc_path FROM doc_tags WHERE tag IN (${placeholders})
           GROUP BY doc_path HAVING COUNT(DISTINCT tag) = ?
         )
         ORDER BY i.updated_at DESC`,
      )
      .all(...tags, tags.length) as DocRow[];
    return rows.map(toSummary);
  }

  // 最近更新された文書(FR-NAV-04)
  recent(limit = 20): DocSummary[] {
    const rows = this.db
      .prepare('SELECT doc_path, title, folder, updated_at FROM doc_index ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as DocRow[];
    return rows.map(toSummary);
  }
}
