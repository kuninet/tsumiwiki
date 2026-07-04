import type { FastifyInstance } from 'fastify';
import { saveDraftRequestSchema } from '@tsumiwiki/shared';
import { sendError } from '../plugins/auth.js';
import { handling } from './docs.js';

// 自動保存の下書きAPI(FR-EDIT-08 / 設計03章)
// 下書きの書き込みはロック保持者のみ。取得は自分の下書きのみ。

export function registerDraftRoutes(app: FastifyInstance): void {
  app.put('/api/drafts', async (req, reply) => {
    const parsed = saveDraftRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '下書きの内容が不正です');
    }
    return handling(reply, async () => {
      app.lockService.assertHeldBy(parsed.data.path, req.user!.id);
      app.draftService.save(parsed.data.path, req.user!.id, parsed.data.content);
      return { ok: true };
    });
  });

  app.get('/api/drafts', async (req, reply) => {
    const { path: docPath } = req.query as { path?: string };
    if (!docPath) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'pathを指定してください');
    }
    return handling(reply, async () => {
      const draft = app.draftService.getOwn(docPath, req.user!.id);
      return { draft: draft ? { content: draft.content, updatedAt: draft.updatedAt } : null };
    });
  });

  app.delete('/api/drafts', async (req, reply) => {
    const { path: docPath } = req.query as { path?: string };
    if (!docPath) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'pathを指定してください');
    }
    return handling(reply, async () => {
      // 自分の下書きのみ破棄できる
      const draft = app.draftService.getOwn(docPath, req.user!.id);
      if (draft) {
        app.draftService.remove(docPath);
      }
      return { ok: true };
    });
  });
}
