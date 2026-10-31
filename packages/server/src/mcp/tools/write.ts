import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MCP_AUTHOR, MCP_SENTINEL_USER_ID } from '../server.js';
import { DocLockedError } from '../../services/lock-service.js';
import { lockedError, toolError, toolResult as asResult } from '../tool-result.js';

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
        '既存ノートの本文・タグ・フロントマターのプロパティを更新する。baseUpdatedAtにはread_noteで取得したupdatedAtを渡すこと' +
        '(取得後に他者が更新していると競合エラーになる)。UIで編集ロック保持中のノートは保存できない',
      inputSchema: {
        path: z.string().min(1).describe('保存するノートの相対パス'),
        body: z.string().describe('更新後の本文(フロントマターを除く部分)'),
        baseUpdatedAt: z.string().describe('read_noteで取得したupdatedAt(競合検知用)'),
        tags: z.array(z.string()).optional().describe('更新後のタグ(未指定なら変更しない)'),
        frontmatter: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            '更新するフロントマターのプロパティ(部分更新・マージ)。指定キーのみ上書きし、' +
            '値にnullを渡すとそのキーを削除する。未指定キーは原文のまま保持。' +
            'tags は tags 引数で、updated はサーバー管理のため指定不可。' +
            '変更するキーだけを渡すこと(read_noteの日付値はISO形式に変換されているため、そのまま戻すと書式が変わる)',
          ),
      },
    },
    async ({ path: docPath, body, baseUpdatedAt, tags, frontmatter }) =>
      asResult(
        await app.docService.saveDocMcp(docPath, body, tags, baseUpdatedAt, MCP_AUTHOR, frontmatter),
      ),
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

  mcp.registerTool(
    'update_frontmatter',
    {
      title: 'フロントマター更新',
      description:
        'ノートの本文は変えずに、フロントマターのプロパティとタグだけを更新する。' +
        'frontmatter / tags / addTags / removeTags のいずれかは必須。tags と addTags/removeTags は同時に指定できない。' +
        'タグの対象はフロントマターの tags のみで、本文中のインライン #タグは変更しない。' +
        'baseUpdatedAt を渡すと取得後の他者更新を競合として検知する(任意)。' +
        'UIで編集ロック保持中のノートには書けない(isError、structuredContent.code が DOC_LOCKED)。' +
        '戻り値は updatedAt と更新後の frontmatter / tags',
      inputSchema: {
        path: z.string().min(1).describe('更新するノートの相対パス'),
        frontmatter: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            '更新するフロントマターのプロパティ(部分更新・マージ)。指定キーのみ上書きし、' +
            '値にnullを渡すとそのキーを削除する。未指定キーは原文のまま保持。' +
            'tags は tags 引数で、updated はサーバー管理のため指定不可。' +
            '変更するキーだけを渡すこと(read_noteの日付値はISO形式に変換されているため、そのまま戻すと書式が変わる)',
          ),
        tags: z.array(z.string()).optional().describe('フロントマターのタグを全て置き換える'),
        addTags: z.array(z.string()).optional().describe('フロントマターのタグに追加する(重複は無視)'),
        removeTags: z.array(z.string()).optional().describe('フロントマターのタグから削除する'),
        baseUpdatedAt: z
          .string()
          .optional()
          .describe('read_noteで取得したupdatedAt。指定時のみ競合検知する(本文を書き換えないので任意)'),
      },
    },
    async ({ path: docPath, frontmatter, tags, addTags, removeTags, baseUpdatedAt }) => {
      if (tags !== undefined && (addTags !== undefined || removeTags !== undefined)) {
        return toolError({
          code: 'INVALID_ARGUMENTS',
          message: 'tags(全置き換え)と addTags / removeTags(差分)は同時に指定できません',
        });
      }
      if (
        frontmatter === undefined &&
        tags === undefined &&
        addTags === undefined &&
        removeTags === undefined
      ) {
        return toolError({
          code: 'NOTHING_TO_UPDATE',
          message: 'frontmatter / tags / addTags / removeTags のいずれかを指定してください',
        });
      }
      try {
        return asResult(
          await app.docService.updateFrontmatterMcp(
            docPath,
            { frontmatter, tags, addTags, removeTags },
            baseUpdatedAt,
            MCP_AUTHOR,
          ),
        );
      } catch (e) {
        if (e instanceof DocLockedError) return lockedError(e);
        throw e;
      }
    },
  );

  mcp.registerTool(
    'create_folder',
    {
      title: 'フォルダ作成',
      description: 'フォルダを作成する(途中のフォルダもまとめて作成する)。空フォルダはGit管理外',
      inputSchema: {
        path: z.string().min(1).describe('作成するフォルダの相対パス(例: 議事録/2026)'),
      },
    },
    async ({ path: folderPath }) => {
      await app.docService.createFolder(folderPath);
      return asResult({ ok: true, path: folderPath });
    },
  );

  mcp.registerTool(
    'move_folder',
    {
      title: 'フォルダ移動・改名',
      description:
        'フォルダを移動または改名する(配下のノートごと移動する)。' +
        '例: path "議事録/2026" を newPath "議事録/2026年度" にすると改名。' +
        '配下のノートをUIで誰かが編集ロック中なら拒否される。移動先に同名フォルダがある場合や、自分自身の配下への移動もエラー',
      inputSchema: {
        path: z.string().min(1).describe('移動元フォルダの現在の相対パス'),
        newPath: z.string().min(1).describe('移動後(改名後)のフォルダの相対パス'),
      },
    },
    async ({ path: folderPath, newPath }) =>
      asResult(
        await app.docService.moveFolder(folderPath, newPath, MCP_SENTINEL_USER_ID, MCP_AUTHOR),
      ),
  );
}
