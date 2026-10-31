import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { REV_PATTERN } from '@tsumiwiki/shared';
import { toolResult as asResult } from '../tool-result.js';

// 履歴閲覧ツール(issue #292)。REST の /api/history と同じ docService を呼ぶ読み取り専用ラッパー。
// 復元(restore)は編集ロック前提の操作のため提供しない

const rev = z.string().regex(REV_PATTERN, 'リビジョン指定が不正です');

export function registerHistoryTools(mcp: McpServer, app: FastifyInstance): void {
  mcp.registerTool(
    'get_history',
    {
      title: 'ノートの変更履歴',
      description:
        '指定ノートの変更履歴(コミット一覧。新しい順)を取得する。各エントリの rev を他の履歴ツールに渡せる',
      inputSchema: {
        path: z.string().min(1).describe('ノートの相対パス'),
      },
    },
    async ({ path: docPath }) => asResult({ history: await app.docService.history(docPath) }),
  );

  mcp.registerTool(
    'get_history_content',
    {
      title: '過去版の本文取得',
      description: '指定ノートの過去の版(rev)の全文(フロントマター含む)を取得する',
      inputSchema: {
        path: z.string().min(1).describe('ノートの相対パス'),
        rev: rev.describe('get_history で得たリビジョン(コミットハッシュ)'),
      },
    },
    async ({ path: docPath, rev: r }) =>
      asResult({ content: await app.docService.contentAt(docPath, r) }),
  );

  mcp.registerTool(
    'get_history_diff',
    {
      title: '版間の差分取得',
      description:
        '指定ノートの rev と against の間の差分(unified diff)を取得する。against を省略すると現行版(HEAD)との差分',
      inputSchema: {
        path: z.string().min(1).describe('ノートの相対パス'),
        rev: rev.describe('比較元のリビジョン'),
        against: rev.optional().describe('比較先のリビジョン(省略時は HEAD)'),
      },
    },
    async ({ path: docPath, rev: r, against }) =>
      asResult({ diff: await app.docService.diffVersions(docPath, r, against) }),
  );

  mcp.registerTool(
    'list_library_history',
    {
      title: 'ライブラリ全体の変更履歴',
      description:
        'ライブラリ全体の変更履歴(新しい順)を取得する。.trash や添付ファイルなど文書以外のパスも含む',
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe('最大件数(1〜1000)'),
      },
    },
    async ({ limit }) => asResult({ history: await app.docService.historyAll(limit) }),
  );
}
