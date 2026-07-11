import type { FastifyInstance } from 'fastify';
import { REV_PATTERN, restoreRequestSchema } from '@tsumiwiki/shared';
import { sendError } from '../plugins/auth.js';
import { authorOf, handling } from './docs.js';

// 履歴API(FR-HIST / 設計03章)

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

  app.get('/api/history/all', async (req, reply) => {
    const { limit } = req.query as { limit?: string };
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    if (limit !== undefined && (Number.isNaN(parsed) || parsed! < 1 || parsed! > 1000)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'limitは1〜1000の整数で指定してください');
    }
    return handling(reply, async () => ({ history: await app.docService.historyAll(parsed) }));
  });

  // 全体履歴用: 指定コミット単体で加わった差分(rev^..rev)。全体履歴は非文書パス
  // (.gitignore・.trash 配下・添付ファイル等)も含みうるためこちらのルートを使う
  app.get('/api/history/all/diff', async (req, reply) => {
    const { path: filePath, rev } = req.query as { path?: string; rev?: string };
    if (!filePath || !rev || !REV_PATTERN.test(rev)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'pathとrevを指定してください');
    }
    return handling(reply, async () => ({
      diff: await app.docService.diffCommitForAnyPath(filePath, rev),
    }));
  });

  app.get('/api/history/content', async (req, reply) => {
    const { path: docPath, rev } = req.query as { path?: string; rev?: string };
    if (!docPath || !rev || !REV_PATTERN.test(rev)) {
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
    if (!docPath || !rev || !REV_PATTERN.test(rev) || (against && !REV_PATTERN.test(against))) {
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
