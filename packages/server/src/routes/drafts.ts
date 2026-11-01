import type { FastifyInstance } from 'fastify';
import { saveDraftRequestSchema } from '@tsumiwiki/shared';
import { isEditableDocPath, normalizeRelPath } from '../lib/paths.js';
import { sendError } from '../plugins/auth.js';
import { handling } from './docs.js';

// 自動保存の下書きAPI(FR-EDIT-08 / 設計03章)
// 下書きは人ごとに分かれているので、ロックを持っていなくても書き込める(#300)。
// ただし、ほかのユーザーが有効なロックを持っている文書には書き込めない。取得は自分の下書きのみ。

export function registerDraftRoutes(app: FastifyInstance): void {
  app.put('/api/drafts', async (req, reply) => {
    const parsed = saveDraftRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '下書きの内容が不正です');
    }
    return handling(reply, async () => {
      // ロックの取得と同じく、存在する .md 文書(保護パス以外)にだけ書き込める
      const normalized = normalizeRelPath(parsed.data.path);
      if (!isEditableDocPath(app.config.libraryPath, normalized)) {
        return sendError(reply, 404, 'NOT_FOUND', `文書が見つかりません: ${normalized}`);
      }
      app.lockService.assertNotLockedByOther(normalized, req.user!.id);
      app.draftService.save(normalized, req.user!.id, parsed.data.content);
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
      if (!draft) {
        return sendError(reply, 404, 'NOT_FOUND', '下書きがありません');
      }
      app.draftService.removeOwn(docPath, req.user!.id);
      return { ok: true };
    });
  });
}
