import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MCP_AUTHOR, MCP_SENTINEL_USER_ID } from '../server.js';
import { toolResult as asResult } from '../tool-result.js';

// 書き込み系ツール(issue #190)。docServiceを経由し生fsは使わない

export function registerWriteTools(mcp: McpServer, app: FastifyInstance): void {
  mcp.registerTool(
    'create_note',
    {
      title: 'ノート新規作成',
      description:
        '指定パスに新規ノートを作成する。パスは.md終端が必須。既に同じパスのノートがあればエラーになる',
      inputSchema: {
        path: z.string().min(1).describe('作成するノートの相対パス(.md終端。例: 日記/メモ.md)'),
        content: z.string().describe('ノート本文(フロントマターを含めてよい)'),
      },
    },
    async ({ path: docPath, content }) =>
      asResult(await app.docService.createDocWithContent(docPath, content, MCP_AUTHOR)),
  );

  mcp.registerTool(
    'save_note',
    {
      title: 'ノート保存',
      description:
        '既存ノートの本文・タグを更新する。baseUpdatedAtにはread_noteで取得したupdatedAtを渡すこと' +
        '(取得後に他者が更新していると競合エラーになる)。UIで編集ロック保持中のノートは保存できない',
      inputSchema: {
        path: z.string().min(1).describe('保存するノートの相対パス'),
        body: z.string().describe('更新後の本文(フロントマターを除く部分)'),
        baseUpdatedAt: z.string().describe('read_noteで取得したupdatedAt(競合検知用)'),
        tags: z.array(z.string()).optional().describe('更新後のタグ(未指定なら変更しない)'),
      },
    },
    async ({ path: docPath, body, baseUpdatedAt, tags }) =>
      asResult(await app.docService.saveDocMcp(docPath, body, tags, baseUpdatedAt, MCP_AUTHOR)),
  );

  mcp.registerTool(
    'move_note',
    {
      title: 'ノート移動・改名',
      description: 'ノートを別フォルダへ移動し、または改名する',
      inputSchema: {
        path: z.string().min(1).describe('移動対象ノートの現在の相対パス'),
        newFolder: z.string().describe('移動先フォルダ(ルート直下は空文字)'),
        newTitle: z.string().min(1).describe('移動後のタイトル(拡張子なし)'),
      },
    },
    async ({ path: docPath, newFolder, newTitle }) =>
      asResult(
        await app.docService.moveDoc(docPath, newFolder, newTitle, MCP_SENTINEL_USER_ID, MCP_AUTHOR),
      ),
  );

  mcp.registerTool(
    'delete_note',
    {
      title: 'ノート削除',
      description: 'ノートをごみ箱(.trash)へ移動する(完全削除ではない)',
      inputSchema: {
        path: z.string().min(1).describe('削除対象ノートの相対パス'),
      },
    },
    async ({ path: docPath }) => {
      await app.docService.deleteDoc(docPath, MCP_SENTINEL_USER_ID, MCP_AUTHOR);
      return asResult({ ok: true });
    },
  );
}
