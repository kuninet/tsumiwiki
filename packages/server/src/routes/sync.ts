import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { syncDocsRequestSchema, SYNC_DOCS_MAX_PATHS } from '@tsumiwiki/shared';
import { InvalidPathError } from '../lib/paths.js';
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
    // sizeもETagの算出元に含める: indexer-service.ts のscanAllはmtime(ms)+size一致で
    // unchanged判定しており、同一mtime tick内のサイズ変化はmtimeだけでは検知できない
    // (indexer-service.ts参照)。ETagがdoc_indexと同じ判定基準を使わないと、
    // doc_indexは更新されたのにETagが変わらず端末が304で古い内容のまま留まりうる
    hash.update(row.doc_path);
    hash.update('\0');
    hash.update(row.updated_at);
    hash.update('\0');
    hash.update(String(row.size));
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
        // 同期中にサーバー側で削除された文書はスキップする(同期全体を失敗させない)。
        // InvalidPathErrorもここでスキップする: マニフェスト由来のパスしか
        // 送らない設計であり、不正パスが1件混ざっただけでバッチ全体を400で
        // 落とすより、そのパスだけ落として残りの同期を成立させる方を優先する
        if (e instanceof DocNotFoundError || e instanceof InvalidPathError) continue;
        throw e;
      }

      // DB検索はgetDocが返す正規化済みパス(doc.path)を使う。
      // 引数pはNFD等の非正規化表記でありうるが、doc_index/doc_tagsはNFCで
      // 格納されている(indexer-service.ts)ため、pのままでは一致せず無言で
      // 取りこぼす(200 + docs:[]になる)
      // title/folderはdoc_index由来(getDocはファイルから直接読むため持っていない)。
      // updatedAtも doc_index 由来に揃える(doc.updatedAt=ファイルの実mtimeではない):
      // manifestが返すupdatedAtはdoc_index.updated_atであり、watcherのデバウンス待ちや
      // 外部コピー直後はファイルの実mtimeとインデックスの値がずれうる。ここでdoc.updatedAtを
      // 返すと、端末はmanifestと突合するたびに「updatedAtが違う」と判定して同じ文書を
      // 永久に取り直し続ける(取り直すたび新しいmtimeを保存するため自己解消しない)。
      // 突合の基準をdoc_index側に一本化することで、インデックス反映が遅れていても収束する
      const indexRow = app.db
        .prepare('SELECT title, folder, updated_at FROM doc_index WHERE doc_path = ?')
        .get(doc.path) as { title: string; folder: string; updated_at: string } | undefined;
      if (!indexRow) continue; // インデックス未反映(通常起こらないが念のため)

      // タグはgetDocのtags(フロントマター由来のみ)ではなく doc_tags から取る。
      // doc_tagsにはsource='frontmatter'/'inline'の両方が入っており、
      // オンライン時の検索・絞り込み(/api/tags, /api/tags/docs = query-service)は
      // source を問わず doc_tags 全体を見ている。オフライン閲覧時のタグ絞り込み(#254)を
      // オンライン時と同じ結果にするため、ここでも両方のsourceを合わせて返す
      const tagRows = app.db
        .prepare('SELECT DISTINCT tag FROM doc_tags WHERE doc_path = ? ORDER BY tag')
        .all(doc.path) as { tag: string }[];

      docs.push({
        path: doc.path,
        title: indexRow.title,
        folder: indexRow.folder,
        updatedAt: indexRow.updated_at,
        tags: tagRows.map((r) => r.tag),
        body: doc.body,
      });
    }

    return { docs };
  });
}
