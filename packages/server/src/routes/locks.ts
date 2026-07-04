import type { FastifyInstance } from 'fastify';
import { lockRequestSchema } from '@tsumiwiki/shared';
import { requireAdmin, sendError } from '../plugins/auth.js';
import { handling } from './docs.js';

// 編集ロックAPI(FR-LOCK / 設計03章)

export function registerLockRoutes(app: FastifyInstance): void {
  app.post('/api/locks', async (req, reply) => {
    const parsed = lockRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'pathを指定してください');
    }
    return handling(reply, async () => {
      const lock = app.lockService.acquire(parsed.data.path, req.user!.id);
      return { lock: { userId: lock.userId, displayName: lock.displayName } };
    });
  });

  app.put('/api/locks/refresh', async (req, reply) => {
    const parsed = lockRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'pathを指定してください');
    }
    return handling(reply, async () => {
      app.lockService.refresh(parsed.data.path, req.user!.id);
      return { ok: true };
    });
  });

  app.delete('/api/locks', async (req, reply) => {
    const { path: docPath } = req.query as { path?: string };
    if (!docPath) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'pathを指定してください');
    }
    return handling(reply, async () => {
      app.lockService.release(docPath, req.user!.id);
      return { ok: true };
    });
  });

  // 残留ロックの強制解除(FR-LOCK-04。admin専用)
  app.delete('/api/locks/force', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const { path: docPath } = req.query as { path?: string };
    if (!docPath) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'pathを指定してください');
    }
    return handling(reply, async () => {
      app.lockService.forceRelease(docPath);
      return { ok: true };
    });
  });
}
