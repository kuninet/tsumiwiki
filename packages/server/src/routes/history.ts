import type { FastifyInstance } from 'fastify';
import { restoreRequestSchema } from '@tsumiwiki/shared';
import { sendError } from '../plugins/auth.js';
import { authorOf, handling } from './docs.js';

// 履歴API(FR-HIST / 設計03章)

const REV_RE = /^[0-9a-f]{4,40}$/i;

export function registerHistoryRoutes(app: FastifyInstance): void {
  app.get('/api/history', async (req, reply) => {
    const { path: docPath } = req.query as { path?: string };
    if (!docPath) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'pathを指定してください');
    }
    return handling(reply, async () => {
      return { history: await app.docService.history(docPath) };
    });
  });

  app.get('/api/history/content', async (req, reply) => {
    const { path: docPath, rev } = req.query as { path?: string; rev?: string };
    if (!docPath || !rev || !REV_RE.test(rev)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'pathとrevを指定してください');
    }
    return handling(reply, async () => {
      return { content: await app.docService.contentAt(docPath, rev) };
    });
  });

  app.get('/api/history/diff', async (req, reply) => {
    const {
      path: docPath,
      rev,
      against,
    } = req.query as { path?: string; rev?: string; against?: string };
    if (!docPath || !rev || !REV_RE.test(rev) || (against && !REV_RE.test(against))) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'pathとrevを指定してください');
    }
    return handling(reply, async () => {
      return { diff: await app.docService.diffVersions(docPath, rev, against) };
    });
  });

  app.post('/api/history/restore', async (req, reply) => {
    const parsed = restoreRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? '入力が不正です');
    }
    return handling(reply, () =>
      app.docService.restoreDoc(parsed.data.path, parsed.data.rev, req.user!.id, authorOf(req)),
    );
  });
}
