import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { renameAttachmentRequestSchema } from '@tsumiwiki/shared';
import { MIME_BY_EXT } from '../lib/attachments.js';
import { InvalidPathError, isProtectedPath, normalizeRelPath, resolveInLibrary } from '../lib/paths.js';
import { sendError } from '../plugins/auth.js';
import { DocService } from '../services/doc-service.js';
import { authorOf, handling } from './docs.js';

// 添付アップロード・ファイル配信API(FR-IMG / 設計03章)

// ライブラリ内ファイルを/api/files/*と/api/embedで共用する配信処理。
// normalizedは既にnormalizeRelPath済みであること(呼び出し側で検証する)
async function serveLibraryFile(
  app: FastifyInstance,
  reply: FastifyReply,
  normalized: string,
): Promise<FastifyReply> {
  if (
    !normalized ||
    isProtectedPath(normalized) ||
    normalized.split('/').includes('.trash') ||
    normalized.toLowerCase().endsWith('.md')
  ) {
    return sendError(reply, 404, 'NOT_FOUND', 'ファイルが見つかりません');
  }
  let abs: string;
  try {
    abs = resolveInLibrary(app.config.libraryPath, normalized);
  } catch (e) {
    if (e instanceof InvalidPathError) {
      return sendError(reply, 400, 'INVALID_PATH', 'パスが不正です');
    }
    throw e;
  }
  let st;
  try {
    st = await stat(abs);
  } catch {
    // 索引が実体より古い(索引にあるがファイルが無い)場合もここで404になる
    return sendError(reply, 404, 'NOT_FOUND', 'ファイルが見つかりません');
  }
  if (!st.isFile()) {
    return sendError(reply, 404, 'NOT_FOUND', 'ファイルが見つかりません');
  }

  // 配信は既知の拡張子に限定する(防御的措置)
  const ext = path.posix.extname(normalized).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    return sendError(reply, 404, 'NOT_FOUND', 'ファイルが見つかりません');
  }
  // PDFはブラウザ内蔵ビューアが自ページ内リソースを読み込むため、画像/SVGより緩いCSPを使う。
  // 画像・SVGは引き続き default-src 'none' でSVG内スクリプト等の実行を封じる(NFR-SEC-03)
  const csp =
    ext === '.pdf'
      ? "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: blob:; font-src 'self' data:"
      : "default-src 'none'; style-src 'unsafe-inline'";
  return reply
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', csp)
    .header('Content-Disposition', ext === '.svg' ? 'attachment' : 'inline')
    .header('Cache-Control', 'private, max-age=60')
    .type(mime)
    .send(createReadStream(abs));
}

export function registerAttachmentRoutes(app: FastifyInstance): void {
  // docPathはクエリで受ける(multipartのフィールド順に依存しないため)
  app.post('/api/attachments', async (req, reply) => {
    const { docPath } = req.query as { docPath?: string };
    if (!docPath) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'docPathを指定してください');
    }
    const file = await req.file();
    if (!file) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'ファイルを指定してください');
    }
    const ext = path.posix.extname(file.filename.normalize('NFC')).toLowerCase();
    if (!DocService.ATTACHMENT_EXTENSIONS.has(ext)) {
      return sendError(
        reply,
        400,
        'VALIDATION_ERROR',
        `対応していないファイル形式です(対応: ${[...DocService.ATTACHMENT_EXTENSIONS].join(' ')})`,
      );
    }

    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch (e) {
      // サイズ超過とそれ以外(不正なmultipart等)を区別する
      if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        return sendError(
          reply,
          413,
          'PAYLOAD_TOO_LARGE',
          `ファイルサイズが上限(${app.config.maxUploadMb}MB)を超えています`,
        );
      }
      req.log?.warn({ err: e }, 'アップロードの解析に失敗しました');
      return sendError(reply, 400, 'VALIDATION_ERROR', 'アップロードの解析に失敗しました');
    }
    return handling(reply, async () => {
      const result = await app.docService.addAttachment(docPath, file.filename, data, authorOf(req));
      return reply.code(201).send(result);
    });
  });

  // ライブラリ内ファイルのraw配信(画像表示用。Markdownは配信しない)
  app.get('/api/files/*', async (req, reply) => {
    const raw = (req.params as { '*': string })['*'];
    let normalized: string;
    try {
      normalized = normalizeRelPath(raw);
    } catch {
      return sendError(reply, 400, 'INVALID_PATH', 'パスが不正です');
    }
    return serveLibraryFile(app, reply, normalized);
  });

  // Obsidian同等のファイル名索引による埋め込み解決+配信(issue #198)。
  // target: `![[target]]`の中身相当。from: 参照元文書の相対パス(任意)
  app.get('/api/embed', async (req, reply) => {
    const { target, from } = req.query as { target?: unknown; from?: unknown };
    // クエリ重複(?target=a&target=b)はfastifyが配列を渡すため文字列以外は拒否する
    if (typeof target !== 'string' || !target) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'targetを指定してください');
    }
    const fromPath = typeof from === 'string' ? from : '';
    const resolved = app.indexerService.resolveAttachment(target, fromPath);
    if (!resolved) {
      return sendError(reply, 404, 'NOT_FOUND', 'ファイルが見つかりません');
    }
    return serveLibraryFile(app, reply, resolved);
  });

  // ---- 添付の管理(名前変更・削除・参照調査。issue #199) ----

  // /api/embedと同じ規則で解決し、実パスとファイル名を返す(クライアントの右クリック
  // メニュー起動時に、いま指している添付が何かを特定するために使う)
  app.get('/api/attachments/resolve', async (req, reply) => {
    const { target, from } = req.query as { target?: unknown; from?: unknown };
    if (typeof target !== 'string' || !target) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'targetを指定してください');
    }
    const fromPath = typeof from === 'string' ? from : '';
    const resolved = app.indexerService.resolveAttachment(target, fromPath);
    if (!resolved) {
      return sendError(reply, 404, 'NOT_FOUND', 'ファイルが見つかりません');
    }
    return { path: resolved, name: path.posix.basename(resolved) };
  });

  // 指定添付を参照している文書パス一覧(削除確認ダイアログの「他N文書からも参照」表示用)
  app.get('/api/attachments/references', async (req, reply) => {
    const { path: attachmentPath } = req.query as { path?: unknown };
    if (typeof attachmentPath !== 'string' || !attachmentPath) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'pathを指定してください');
    }
    return handling(reply, async () => {
      const docs = await app.docService.findAttachmentReferences(attachmentPath);
      return { docs };
    });
  });

  // リネーム: ライブラリ内の参照文書を1コミットで書き換える
  app.post('/api/attachments/rename', async (req, reply) => {
    const parsed = renameAttachmentRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'パスと新しいファイル名を指定してください');
    }
    return handling(reply, () =>
      app.docService.renameAttachment(parsed.data.path, parsed.data.newName, authorOf(req)),
    );
  });

  // 削除: ごみ箱へ移動する(参照文書は書き換えない。Obsidianと同じ挙動)
  app.delete('/api/attachments', async (req, reply) => {
    const { path: attachmentPath } = req.query as { path?: unknown };
    // クエリ重複(?path=a&path=b)はfastifyが配列を渡すため文字列以外は拒否する
    if (typeof attachmentPath !== 'string' || !attachmentPath) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'pathを指定してください');
    }
    return handling(reply, async () => {
      await app.docService.deleteAttachment(attachmentPath, authorOf(req));
      return { ok: true };
    });
  });
}
