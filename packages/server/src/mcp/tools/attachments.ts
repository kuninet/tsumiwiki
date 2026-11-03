import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resizeAttachmentImage } from '../../lib/image-resize.js';
import { DocService } from '../../services/doc-service.js';
import { MCP_AUTHOR } from '../server.js';
import { docError, toolError, toolResult } from '../tool-result.js';

// 戻り値 null は INVALID_BASE64
export function decodeBase64Strict(input: string): Buffer | null {
  if (input.trimStart().startsWith('data:')) {
    return null; // data: URL接頭辞付きは拒否
  }
  const s = input.replace(/\s+/g, '');
  if (s.length === 0 || s.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null; // = は末尾最大2個
  return Buffer.from(s, 'base64');
}

export function registerAttachmentTools(mcp: McpServer, app: FastifyInstance): void {
  mcp.registerTool(
    'upload_attachment',
    {
      title: '添付ファイルアップロード',
      description:
        'ノートに画像またはPDFを添付ファイルとして保存する。本文への挿入は呼び出し側で行う(![[fileName]])',
      inputSchema: {
        docPath: z
          .string()
          .min(1)
          .describe('添付先ノートの相対パス(このノートの位置を基準に保存先が決まる)'),
        fileName: z
          .string()
          .min(1)
          .describe('元のファイル名(拡張子で形式を判定。例: diagram.png)'),
        dataBase64: z
          .string()
          .min(1)
          .describe('ファイル内容の base64(data: URL の接頭辞は付けない)'),
      },
    },
    async ({ docPath, fileName, dataBase64 }) => {
      const ext = path.posix.extname(fileName.normalize('NFC')).toLowerCase();
      if (!DocService.ATTACHMENT_EXTENSIONS.has(ext)) {
        return toolError({
          code: 'UNSUPPORTED_FILE_TYPE',
          message: `対応していないファイル形式です(対応: ${[...DocService.ATTACHMENT_EXTENSIONS].join(' ')})`,
        });
      }

      if (dataBase64.trimStart().startsWith('data:')) {
        return toolError({
          code: 'INVALID_BASE64',
          message: 'data: URL の接頭辞を外してください(純粋な base64 文字列を指定してください)',
        });
      }

      const data = decodeBase64Strict(dataBase64);
      if (!data) {
        return toolError({ code: 'INVALID_BASE64', message: 'base64 文字列が不正です' });
      }

      const maxBytes = app.config.maxUploadMb * 1024 * 1024;
      if (data.length > maxBytes) {
        return toolError({
          code: 'PAYLOAD_TOO_LARGE',
          message: `ファイルサイズが上限(${app.config.maxUploadMb}MB)を超えています`,
        });
      }

      // 存在しない docPath で無駄な画像デコードを走らせないよう事前チェック
      try {
        await app.docService.getDoc(docPath);
      } catch (e) {
        return docError(e);
      }

      const resized = (
        await resizeAttachmentImage(data, ext, app.config.attachmentMaxEdgePx, app.log)
      ).data;

      try {
        const result = await app.docService.addAttachment(docPath, fileName, resized, MCP_AUTHOR);
        return toolResult({
          fileName: result.fileName,
          path: result.path,
          embed: `![[${result.fileName}]]`,
        });
      } catch (e) {
        return docError(e);
      }
    },
  );
}
