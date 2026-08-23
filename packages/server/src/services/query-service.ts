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

// snippetハイライトのセンチネル(本文に実質出現しない制御文字列)。
// 本文全体をHTMLエスケープした後、センチネルだけを<mark>へ置換することで
// 文書由来のHTMLが検索結果に混入しない(stored XSS対策)ことを構成的に保証する
const SNIP_OPEN = '\u0001+\u0001';
const SNIP_CLOSE = '\u0001-\u0001';

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

// LIKEのエスケープ文字。SQL側の ESCAPE 句と揃える
const LIKE_ESCAPE = '\\';

// LIKE用のワイルドカード(\ % _)をエスケープする。順序が重要(\を先に二重化)
function toLikePattern(term: string): string {
  const escaped = term
    .replaceAll(LIKE_ESCAPE, LIKE_ESCAPE + LIKE_ESCAPE)
    .replaceAll('%', LIKE_ESCAPE + '%')
    .replaceAll('_', LIKE_ESCAPE + '_');
  return `%${escaped}%`;
}

// SQLite LIKE と同じくASCIIのみ大文字小文字を無視する(1コードポイント→1コードポイントを保つ。
// JSのtoLowerCase()はİ等でコードポイント数が変わりうるため使わない)
function foldAscii(chars: string[]): string[] {
  return chars.map((c) => (c >= 'A' && c <= 'Z' ? c.toLowerCase() : c));
}

// コードポイント配列hay内でneedle配列と一致する部分列の開始位置をfrom以降から探す。needleが空なら-1
function indexOfChars(hay: string[], needle: string[], from = 0): number {
  if (needle.length === 0) return -1;
  const limit = hay.length - needle.length;
  outer: for (let i = Math.max(from, 0); i <= limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// LIKE経路用のsnippetをJSで組み立てる(snippet()関数はMATCH専用のため使えない)。
// 全処理をコードポイント配列に統一することで、絵文字・サロゲートペアが混在してもズレない
function buildLikeSnippet(body: string, terms: string[]): string {
  const chars = [...body];
  const lower = foldAscii(chars);
  const lowerTerms = terms.filter(Boolean).map((term) => foldAscii([...term]));

  let hit = -1;
  for (const lowerTerm of lowerTerms) {
    const idx = indexOfChars(lower, lowerTerm);
    if (idx !== -1 && (hit === -1 || idx < hit)) hit = idx;
  }

  if (hit === -1) {
    // タイトルのみ一致。ハイライト無しで本文先頭を返す(MATCH経路との整合)
    const head = chars.slice(0, 60).join('');
    return chars.length > 60 ? `${head}…` : head;
  }

  const start = Math.max(0, hit - 20);
  const end = Math.min(chars.length, start + 60);
  const windowChars = chars.slice(start, end);
  const lowerWindow = lower.slice(start, end);

  // window内の全語の全出現箇所をセンチネルで囲む。重複ハイライトは作らない
  const ranges: { start: number; end: number }[] = [];
  for (const lowerTerm of lowerTerms) {
    let from = 0;
    for (;;) {
      const idx = indexOfChars(lowerWindow, lowerTerm, from);
      if (idx === -1) break;
      const rStart = Math.max(idx, 0);
      const rEnd = Math.min(idx + lowerTerm.length, windowChars.length);
      const overlaps = ranges.some((r) => rStart < r.end && rEnd > r.start);
      if (!overlaps) ranges.push({ start: rStart, end: rEnd });
      from = idx + 1;
    }
  }
  ranges.sort((a, b) => a.start - b.start);

  let marked = '';
  let cursor = 0;
  for (const r of ranges) {
    marked += windowChars.slice(cursor, r.start).join('');
    marked += SNIP_OPEN + windowChars.slice(r.start, r.end).join('') + SNIP_CLOSE;
    cursor = r.end;
  }
  marked += windowChars.slice(cursor).join('');

  const prefix = start > 0 ? '…' : '';
  const suffix = end < chars.length ? '…' : '';
  return prefix + marked + suffix;
}

export class QueryService {
  constructor(private readonly db: AppDatabase) {}

  // 全文検索(FR-NAV-03)。snippetはヒット箇所前後をハイライト付きで返す。
  // 3文字未満の語を含む場合はtrigramインデックスでヒットしないため、LIKE(フルスキャン)にフォールバックする
  search(q: string, limit = 50): SearchResult[] {
    const terms = q.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    if (terms.some((term) => [...term].length < 3)) {
      return this.searchByLike(terms, limit);
    }

    const ftsQuery = toFtsQuery(q);
    if (!ftsQuery) return [];
    const rows = this.db
      .prepare(
        `SELECT f.doc_path, f.title,
                snippet(doc_fts, 2, ?, ?, '…', 20) AS snip
         FROM doc_fts f
         WHERE doc_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(SNIP_OPEN, SNIP_CLOSE, ftsQuery, limit) as {
      doc_path: string;
      title: string;
      snip: string;
    }[];
    return rows.map((r) => ({
      path: r.doc_path,
      title: r.title,
      snippet: escapeHtml(r.snip).replaceAll(SNIP_OPEN, '<mark>').replaceAll(SNIP_CLOSE, '</mark>'),
    }));
  }

  private searchByLike(terms: string[], limit: number): SearchResult[] {
    const patterns = terms.map(toLikePattern);
    const likeCondition = `(f.title LIKE ? ESCAPE '${LIKE_ESCAPE}' OR f.body LIKE ? ESCAPE '${LIKE_ESCAPE}')`;
    const conditions = patterns.map(() => likeCondition).join(' AND ');
    const whereParams = patterns.flatMap((p) => [p, p]);
    const rows = this.db
      .prepare(
        `SELECT f.doc_path, f.title, f.body, i.updated_at
         FROM doc_fts f
         JOIN doc_index i ON i.doc_path = f.doc_path
         WHERE ${conditions}
         ORDER BY (f.title LIKE ? ESCAPE '${LIKE_ESCAPE}') DESC, i.updated_at DESC
         LIMIT ?`,
      )
      .all(...whereParams, patterns[0], limit) as {
      doc_path: string;
      title: string;
      body: string;
      updated_at: string;
    }[];
    return rows.map((r) => ({
      path: r.doc_path,
      title: r.title,
      snippet: escapeHtml(buildLikeSnippet(r.body, terms))
        .replaceAll(SNIP_OPEN, '<mark>')
        .replaceAll(SNIP_CLOSE, '</mark>'),
    }));
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
