import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { InvalidPathError, isProtectedPath, normalizeRelPath, resolveInLibrary } from '../lib/paths.js';
import { sendError } from '../plugins/auth.js';
import { DocService } from '../services/doc-service.js';
import { authorOf, handling } from './docs.js';

// 添付アップロード・ファイル配信API(FR-IMG / 設計03章)

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

export function registerAttachmentRoutes(app: FastifyInstance): void {
  app.post('/api/attachments', async (req, reply) => {
    const file = await req.file();
    if (!file) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'ファイルを指定してください');
    }
    const docPathField = file.fields.docPath;
    const docPath =
      docPathField && 'value' in docPathField ? String(docPathField.value) : undefined;
    if (!docPath) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'docPathを指定してください');
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
    } catch {
      // fileSize上限超過(@fastify/multipartのlimits)
      return sendError(
        reply,
        413,
        'PAYLOAD_TOO_LARGE',
        `ファイルサイズが上限(${app.config.maxUploadMb}MB)を超えています`,
      );
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
      return sendError(reply, 404, 'NOT_FOUND', 'ファイルが見つかりません');
    }
    if (!st.isFile()) {
      return sendError(reply, 404, 'NOT_FOUND', 'ファイルが見つかりません');
    }

    const ext = path.posix.extname(normalized).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      // SVG内スクリプト等の実行を封じる(NFR-SEC-03)
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      .header('Content-Disposition', 'inline')
      .header('Cache-Control', 'private, max-age=60')
      .type(mime)
      .send(createReadStream(abs));
  });
}
