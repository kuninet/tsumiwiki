import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { syncDocsRequestSchema, SYNC_DOCS_MAX_PATHS } from '@tsumiwiki/shared';
import { sendError } from '../plugins/auth.js';
import { DocNotFoundError } from '../services/doc-service.js';

// オフライン同期API(設計07章7.4。issue #252)
// 方式はマニフェスト突合(sinceカーソル方式は不採用。理由は7.4.1参照)。
// 端末はGET /api/sync/manifestで全件のパス・更新日時・サイズを取得して
// ローカルと突合し、必要な文書だけPOST /api/sync/docsで本文を取りに行く

interface ManifestRow {
  doc_path: string;
  updated_at: string;
  size: number;
}

// If-None-Matchヘッダの弱いETag(`W/`プレフィックス)を剥がしてから比較する。
// プロキシがstrong ETagをweak化して転送してくる場合に備える(RFC 9110の弱い比較相当)
function stripWeakPrefix(value: string): string {
  return value.startsWith('W/') ? value.slice(2) : value;
}

// ETagはdoc_indexの現在の内容から毎回算出する(値をキャッシュしない)。
// こう構成することで、API経由の個々の保存だけでなく、library-watcher/sync-serviceによる
// 外部変更の取り込みでdoc_indexが更新された場合も、次回アクセス時に必ずETagへ反映される
// (設計07章7.4.1・7.4.3)。1,887件のsha256算出は数ミリ秒でありコストにならない
function computeManifestEtag(rows: ManifestRow[]): string {
  const hash = createHash('sha256');
  for (const row of rows) {
    // sizeはETagの算出元に含めない: 本文が変われば必ずmtime(updated_at)も変わるため、
    // (doc_path, updated_at)の集合だけで変更検出には十分。含めても害はないが、
    // 検出力に寄与しない値を二重に持つ理由がないため外した
    hash.update(row.doc_path);
    hash.update('\0');
    hash.update(row.updated_at);
    hash.update('\n');
  }
  return `"${hash.digest('hex')}"`;
}

export function registerSyncRoutes(app: FastifyInstance): void {
  app.get('/api/sync/manifest', async (req, reply) => {
    // ETagの再現性のため並び順を固定する
    const rows = app.db
      .prepare('SELECT doc_path, updated_at, size FROM doc_index ORDER BY doc_path')
      .all() as ManifestRow[];

    const etag = computeManifestEtag(rows);

    const ifNoneMatch = req.headers['if-none-match'];
    if (typeof ifNoneMatch === 'string' && stripWeakPrefix(ifNoneMatch) === etag) {
      // `If-None-Match: *` は単純な文字列比較のため一致しない(仕様どおり一致扱いにしない)
      return reply.code(304).header('ETag', etag).send();
    }

    reply.header('ETag', etag);
    return {
      count: rows.length,
      docs: rows.map((r) => ({ path: r.doc_path, updatedAt: r.updated_at, size: r.size })),
    };
  });

  app.post('/api/sync/docs', async (req, reply) => {
    // X-Requested-Withの検証はauthPluginが変更系メソッド全般に対して行うため、ここでは行わない
    const parsed = syncDocsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'VALIDATION_ERROR',
        `pathsは1件以上${SYNC_DOCS_MAX_PATHS}件以下で指定してください`,
      );
    }

    // レスポンス順はリクエスト順である必要はないが安定させる(パスの辞書順)。
    // 重複パスは1件にまとめる
    const paths = [...new Set(parsed.data.paths)].sort();

    const docs = [];
    for (const p of paths) {
      let doc;
      try {
        doc = await app.docService.getDoc(p);
      } catch (e) {
        // 同期中にサーバー側で削除された文書はスキップする(同期全体を失敗させない)
        if (e instanceof DocNotFoundError) continue;
        throw e;
      }

      // title/folderはdoc_index由来(getDocはファイルから直接読むため持っていない)
      const indexRow = app.db
        .prepare('SELECT title, folder FROM doc_index WHERE doc_path = ?')
        .get(p) as { title: string; folder: string } | undefined;
      if (!indexRow) continue; // インデックス未反映(通常起こらないが念のため)

      // タグはgetDocのtags(フロントマター由来のみ)ではなく doc_tags から取る。
      // doc_tagsにはsource='frontmatter'/'inline'の両方が入っており、
      // オンライン時の検索・絞り込み(/api/tags, /api/tags/docs = query-service)は
      // source を問わず doc_tags 全体を見ている。オフライン閲覧時のタグ絞り込み(#254)を
      // オンライン時と同じ結果にするため、ここでも両方のsourceを合わせて返す
      const tagRows = app.db
        .prepare('SELECT DISTINCT tag FROM doc_tags WHERE doc_path = ? ORDER BY tag')
        .all(p) as { tag: string }[];

      docs.push({
        path: doc.path,
        title: indexRow.title,
        folder: indexRow.folder,
        updatedAt: doc.updatedAt,
        tags: tagRows.map((r) => r.tag),
        body: doc.body,
      });
    }

    return { docs };
  });
}
