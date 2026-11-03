import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MCP_AUTHOR } from '../server.js';
import { docError, toolResult as asResult } from '../tool-result.js';

// ごみ箱系ツール(issue #306)。docServiceを経由し生fsは使わない
export function registerTrashTools(mcp: McpServer, app: FastifyInstance): void {
  mcp.registerTool(
    'list_trash',
    {
      title: 'ごみ箱一覧',
      description: 'ごみ箱(.trash)内のノート・フォルダ一覧を削除日時の新しい順で取得する',
      inputSchema: {},
    },
    async () => {
      try {
        const items = await app.docService.listTrash();
        return asResult(items);
      } catch (e) {
        return docError(e);
      }
    },
  );

  mcp.registerTool(
    'restore_from_trash',
    {
      title: 'ごみ箱から復元',
      description:
        'ごみ箱(.trash)内のノート・添付・フォルダを元のパスへ復元する。元のパスに同名ファイル・フォルダが存在する場合は自動で連番(例: ノート (2).md)が付与される。trashPath には list_trash で取得した trashPath(例: .trash/メモ.md)を指定する。ロック不要',
      inputSchema: {
        trashPath: z.string().min(1).describe('復元対象のごみ箱相対パス(例: .trash/メモ.md)'),
      },
    },
    async ({ trashPath }) => {
      try {
        const result = await app.docService.restoreFromTrash(trashPath, MCP_AUTHOR);
        return asResult(result);
      } catch (e) {
        return docError(e);
      }
    },
  );
}
