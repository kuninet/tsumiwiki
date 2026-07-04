import type { FastifyInstance } from 'fastify';
import { restoreTrashRequestSchema } from '@tsumiwiki/shared';
import { requireAdmin, sendError } from '../plugins/auth.js';
import { authorOf, handling } from './docs.js';

// ごみ箱API(FR-DOC-07 / 設計03章)

export function registerTrashRoutes(app: FastifyInstance): void {
  app.get('/api/trash', async (_req, reply) => {
    return handling(reply, async () => {
      return { entries: await app.docService.listTrash() };
    });
  });

  app.post('/api/trash/restore', async (req, reply) => {
    const parsed = restoreTrashRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'trashPathを指定してください');
    }
    return handling(reply, () =>
      app.docService.restoreFromTrash(parsed.data.trashPath, authorOf(req)),
    );
  });

  // 完全削除はadmin専用(FR-DOC-07)
  app.delete('/api/trash', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const { path: trashPath } = req.query as { path?: string };
    if (!trashPath) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'pathを指定してください');
    }
    return handling(reply, async () => {
      await app.docService.purgeTrash(trashPath, authorOf(req));
      return { ok: true };
    });
  });
}
