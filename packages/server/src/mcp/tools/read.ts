import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EXCLUDED_PROP_KEYS } from '../../services/markdown-meta.js';
import { toolError, toolResult as asResult } from '../tool-result.js';

// 読み取り系ツール(issue #190)。queryService / docServiceを経由し生fsは使わない

export function registerReadTools(mcp: McpServer, app: FastifyInstance): void {
  mcp.registerTool(
    'search_notes',
    {
      title: '全文検索',
      description:
        'TsumiWiki内のマークダウンノートを全文検索する。ヒット箇所のスニペット付きで返す',
      inputSchema: {
        query: z.string().min(1).describe('検索クエリ(空白区切りでAND検索)'),
        limit: z.number().int().positive().max(200).optional().describe('最大件数(既定50)'),
      },
    },
    async ({ query, limit }) => asResult(app.queryService.search(query, limit)),
  );

  mcp.registerTool(
    'read_note',
    {
      title: 'ノート読み取り',
      description: '指定パスのノートの本文・タグ・更新日時などを取得する',
      inputSchema: {
        path: z.string().min(1).describe('ノートの相対パス(例: 日記/2026-08-16.md)'),
      },
    },
    async ({ path: docPath }) => asResult(await app.docService.getDoc(docPath)),
  );

  mcp.registerTool(
    'list_recent',
    {
      title: '最近更新されたノート一覧',
      description: '更新日時の新しい順にノートを一覧する',
      inputSchema: {
        limit: z.number().int().positive().max(200).optional().describe('最大件数(既定20)'),
      },
    },
    async ({ limit }) => asResult(app.queryService.recent(limit)),
  );

  mcp.registerTool(
    'list_tags',
    {
      title: 'タグ一覧',
      description: 'ライブラリ内の全タグと、それぞれのタグを持つノート件数を取得する',
      inputSchema: {},
    },
    async () => asResult(app.queryService.tags()),
  );

  mcp.registerTool(
    'get_docs_by_tags',
    {
      title: 'タグ指定でノート検索',
      description: '指定した全てのタグを持つノートをAND条件で絞り込む',
      inputSchema: {
        tags: z.array(z.string().min(1)).min(1).describe('絞り込むタグの配列(AND条件)'),
      },
    },
    async ({ tags }) => asResult(app.queryService.docsByTags(tags)),
  );

  mcp.registerTool(
    'find_notes_by_property',
    {
      title: 'プロパティ指定でノート検索',
      description:
        'フロントマターのプロパティでノートを探す。value を省略するとそのキーを持つノートすべて。' +
        '配列のプロパティは要素のどれかが一致すれば該当。日付は YYYY-MM-DD で指定する。' +
        'tags は get_docs_by_tags を使うこと',
      inputSchema: {
        key: z.string().min(1).describe('プロパティ名(例: status)'),
        value: z
          .union([z.string(), z.number(), z.boolean()])
          .optional()
          .describe('一致させる値。省略するとそのキーを持つノートすべて'),
        limit: z.number().int().positive().max(200).optional().describe('最大件数(既定50)'),
      },
    },
    async ({ key, value, limit }) => {
      if (EXCLUDED_PROP_KEYS.has(key)) {
        return toolError({
          code: 'USE_TAG_TOOL',
          message: 'タグは get_docs_by_tags で検索してください',
        });
      }
      return asResult(app.queryService.docsByProperty(key, value, limit));
    },
  );

  mcp.registerTool(
    'list_properties',
    {
      title: 'プロパティ一覧',
      description:
        'ライブラリで使われているフロントマターのプロパティ名と件数、よく使われる値を返す。' +
        'find_notes_by_property の前に、どのキー・値があるか調べるのに使う',
      inputSchema: {},
    },
    async () => asResult(app.queryService.properties()),
  );

  mcp.registerTool(
    'get_tree',
    {
      title: 'ライブラリ全体のツリー取得',
      description: 'フォルダ一覧と全ノート(パス・タイトル・フォルダ・更新日時)を取得する',
      inputSchema: {},
    },
    async () => asResult(await app.docService.getTree()),
  );

  mcp.registerTool(
    'get_backlinks',
    {
      title: 'バックリンク取得',
      description:
        '指定ノートへ [[リンク]] を張っているノートの一覧を取得する。リンク元ごとに行番号・前後の文脈を含む。' +
        'limit はリンク元ノートの最大件数(既定200)で、超えた分は切り捨てられ truncated: true になる',
      inputSchema: {
        path: z.string().min(1).describe('リンク先ノートの相対パス(例: 日記/2026-08-16.md)'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('リンク元ノートの最大件数(既定200)'),
      },
    },
    async ({ path: docPath, limit }) =>
      asResult(await app.docService.getBacklinks(docPath, limit ? { limit } : undefined)),
  );
}
