import type { FastifyInstance } from 'fastify';

// ライブラリ運用API(FR-DOC-08 / 設計06章6.4)

export function registerLibraryRoutes(app: FastifyInstance): void {
  // 手動の「更新確認」: 外部変更の即時取り込み(監視が効かない環境の保険)
  app.post('/api/library/rescan', async () => {
    const result = await app.syncService.run();
    return {
      committed: result.committed,
      indexed: result.indexed,
      removed: result.removed,
      unchanged: result.unchanged,
      failedPaths: result.failedPaths,
    };
  });
}
