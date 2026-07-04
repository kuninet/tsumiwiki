import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createDocRequestSchema,
  createFolderRequestSchema,
  moveDocRequestSchema,
  moveFolderRequestSchema,
  saveDocRequestSchema,
} from '@tsumiwiki/shared';
import { InvalidPathError } from '../lib/paths.js';
import { sendError } from '../plugins/auth.js';
import { DocConflictError, DocNotFoundError } from '../services/doc-service.js';
import type { GitAuthor } from '../services/git-service.js';
import { DocLockedError, LockExpiredError } from '../services/lock-service.js';

// 文書・フォルダAPI(設計03章)

function authorOf(req: FastifyRequest): GitAuthor {
  // コミットauthor表記は「表示名 <username@tsumiwiki.local>」(設計06章6.2)
  return {
    name: req.user!.displayName,
    email: `${req.user!.username}@tsumiwiki.local`,
  };
}

// サービス系エラーをAPIエラー形式へ変換する(locks/draftsルートでも共用)
export async function handling<T>(
  reply: FastifyReply,
  fn: () => Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof InvalidPathError) {
      return sendError(reply, 400, 'INVALID_PATH', 'パスが不正です');
    }
    if (e instanceof DocNotFoundError) {
      return sendError(reply, 404, 'NOT_FOUND', e.message);
    }
    if (e instanceof DocConflictError) {
      return sendError(reply, 409, 'CONFLICT', e.message);
    }
    if (e instanceof DocLockedError) {
      return sendError(reply, 409, 'DOC_LOCKED', e.message);
    }
    if (e instanceof LockExpiredError) {
      return sendError(reply, 409, 'LOCK_EXPIRED', e.message);
    }
    throw e;
  }
}

export function registerDocRoutes(app: FastifyInstance): void {
  app.get('/api/tree', async () => {
    return app.docService.getTree();
  });

  app.get('/api/docs', async (req, reply) => {
    const { path: docPath } = req.query as { path?: string };
    if (!docPath) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'pathを指定してください');
    }
    return handling(reply, () => app.docService.getDoc(docPath));
  });

  app.post('/api/docs', async (req, reply) => {
    const parsed = createDocRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'フォルダとタイトルを指定してください');
    }
    return handling(reply, async () => {
      const result = await app.docService.createDoc(
        parsed.data.folder,
        parsed.data.title,
        authorOf(req),
      );
      return reply.code(201).send(result);
    });
  });

  app.put('/api/docs', async (req, reply) => {
    const parsed = saveDocRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '保存内容が不正です');
    }
    const { path: docPath, body, tags, baseUpdatedAt } = parsed.data;
    return handling(reply, () =>
      app.docService.saveDoc(docPath, body, tags, baseUpdatedAt, req.user!.id, authorOf(req)),
    );
  });

  app.delete('/api/docs', async (req, reply) => {
    const { path: docPath } = req.query as { path?: string };
    if (!docPath) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'pathを指定してください');
    }
    return handling(reply, async () => {
      await app.docService.deleteDoc(docPath, req.user!.id, authorOf(req));
      return { ok: true };
    });
  });

  app.post('/api/docs/move', async (req, reply) => {
    const parsed = moveDocRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '移動先の指定が不正です');
    }
    return handling(reply, () =>
      app.docService.moveDoc(
        parsed.data.path,
        parsed.data.newFolder,
        parsed.data.newTitle,
        req.user!.id,
        authorOf(req),
      ),
    );
  });

  // ---- フォルダ ----

  app.post('/api/folders', async (req, reply) => {
    const parsed = createFolderRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'フォルダパスを指定してください');
    }
    return handling(reply, async () => {
      await app.docService.createFolder(parsed.data.path);
      return reply.code(201).send({ ok: true });
    });
  });

  app.post('/api/folders/move', async (req, reply) => {
    const parsed = moveFolderRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '移動先の指定が不正です');
    }
    return handling(reply, async () => {
      await app.docService.moveFolder(parsed.data.path, parsed.data.newPath, req.user!.id, authorOf(req));
      return { ok: true };
    });
  });

  app.delete('/api/folders', async (req, reply) => {
    const { path: folderPath } = req.query as { path?: string };
    if (!folderPath) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'pathを指定してください');
    }
    return handling(reply, async () => {
      await app.docService.deleteFolder(folderPath, req.user!.id, authorOf(req));
      return { ok: true };
    });
  });
}
