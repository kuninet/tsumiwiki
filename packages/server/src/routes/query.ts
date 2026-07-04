import type { FastifyInstance } from 'fastify';
import { sendError } from '../plugins/auth.js';

// 検索・タグ・最近更新API(FR-NAV-02/03/04 / 設計03章)

export function registerQueryRoutes(app: FastifyInstance): void {
  app.get('/api/search', async (req, reply) => {
    const { q } = req.query as { q?: string };
    if (!q || !q.trim()) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '検索語を入力してください');
    }
    // trigramトークナイザの特性上、3文字未満の語はヒットしないことがある
    return { results: app.queryService.search(q.trim()) };
  });

  app.get('/api/tags', async () => {
    return { tags: app.queryService.tags() };
  });

  app.get('/api/tags/docs', async (req, reply) => {
    const { tags } = req.query as { tags?: string };
    const list = [
      ...new Set(
        (tags ?? '')
          .split(',')
          .map((t) => t.trim().replace(/^#/, '').normalize('NFC'))
          .filter(Boolean),
      ),
    ];
    if (list.length === 0) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'tagsを指定してください');
    }
    return { docs: app.queryService.docsByTags(list) };
  });

  app.get('/api/docs/recent', async (req) => {
    const { limit } = req.query as { limit?: string };
    const parsedLimit = Number(limit);
    const n = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 100)
      : 20;
    return { docs: app.queryService.recent(n) };
  });
}
