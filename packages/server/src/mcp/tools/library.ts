import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolResult as asResult } from '../tool-result.js';

// ライブラリ運用ツール(issue #307)
export function registerLibraryTools(mcp: McpServer, app: FastifyInstance): void {
  mcp.registerTool(
    'get_library_status',
    {
      title: 'ライブラリ状態取得',
      description:
        'ライブラリのバックアップ状態(設定有無・最終成功日時・エラー)を取得する',
      inputSchema: {},
    },
    async () => {
      const backup = app.backupService.status();
      return asResult({ backup });
    },
  );

  mcp.registerTool(
    'rescan_library',
    {
      title: 'ライブラリ再スキャン',
      description:
        'ライブラリのファイル変更を再スキャンし、GitコミットとSQLiteインデックスを即時更新する。戻り値は反映結果(committed/indexed/removed/unchanged/failedPaths)',
      inputSchema: {},
    },
    async () => {
      const result = await app.syncService.run();
      return asResult({
        committed: result.committed,
        indexed: result.indexed,
        removed: result.removed,
        unchanged: result.unchanged,
        failedPaths: result.failedPaths,
      });
    },
  );
}
