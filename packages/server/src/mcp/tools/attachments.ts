import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  decodeUriPathSegments,
  extractEmbedRefs,
  folderOfDoc,
  resolveMarkdownRelPath,
  type LinkRef,
} from '../../lib/attachment-links.js';
import { MIME_BY_EXT } from '../../lib/attachments.js';
import { resizeAttachmentImage } from '../../lib/image-resize.js';
import { InvalidPathError, isProtectedPath, resolveInLibrary } from '../../lib/paths.js';
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

// read_attachment の返却サイズ上限(#345)。返却する(base64 / 本文として載せる)形式にだけ適用し、
// メタ情報のみ返す PDF には適用しない
export const READ_ATTACHMENT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const READ_ATTACHMENT_MAX_TEXT_BYTES = 256 * 1024;

export type AttachmentKind = 'text' | 'image' | 'meta';

// 返却形式の判定(拡張子ベース)。MIME は既存の MIME_BY_EXT を使う
export function classifyAttachment(ext: string): AttachmentKind {
  switch (ext.toLowerCase()) {
    case '.svg':
      return 'text';
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
      return 'image';
    default:
      return 'meta';
  }
}

// name の事前検査。resolveAttachment は `..` を「見つからない」(null)として扱うため、
// NOT_FOUND と区別できるよう先に INVALID_PATH にする。
// 先頭の `/` は ![[/dir/a.png]] として画面でも有効な書き方なので拒否しない(解決側が剥がす)
export function isInvalidAttachmentName(name: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(name)) return true;
  const unified = name.replaceAll('\\', '/');
  if (/^[A-Za-z]:/.test(name) || name.startsWith('\\\\')) return true; // ドライブ指定・UNC
  return unified.split('/').some((seg) => seg === '..');
}

type ResolvedFile =
  | { ok: true; abs: string; size: number; mtime: Date }
  | { ok: false; reason: 'NOT_FOUND' | 'INVALID_PATH' };

// 索引で解決済みの相対パスを実ファイルに解決する。順序は realpath → ライブラリ配下検査 → stat。
// stat はリンクを辿るため、先に配下検査をしてライブラリ外ファイルの情報を一切触れない
export async function resolveAttachmentFile(
  libraryPath: string,
  relPath: string,
): Promise<ResolvedFile> {
  let real: string;
  let rootReal: string;
  try {
    const abs = resolveInLibrary(libraryPath, relPath);
    rootReal = await realpath(libraryPath);
    real = await realpath(abs);
  } catch (e) {
    if (e instanceof InvalidPathError) return { ok: false, reason: 'INVALID_PATH' };
    return { ok: false, reason: 'NOT_FOUND' };
  }
  if (!real.startsWith(rootReal + path.sep)) return { ok: false, reason: 'INVALID_PATH' };
  try {
    const st = await stat(real);
    if (!st.isFile()) return { ok: false, reason: 'NOT_FOUND' };
    return { ok: true, abs: real, size: st.size, mtime: st.mtime };
  } catch {
    return { ok: false, reason: 'NOT_FOUND' };
  }
}

// 埋め込み参照を実ファイルに解決する(list_attachments 用)。
// - Wikilink(`![[...]]`): 画面と同じ添付索引の解決(resolveAttachment)
// - 標準記法(`![](...)`): 画面(resolveImageSrc → 失敗時 imageFallbackSrc)と同じく、
//   セグメント単位の URL デコード → ノートのフォルダ基準の相対解決 → だめなら basename で索引解決
// どちらも解決後は realpath → ライブラリ配下検査 → stat を通す(ルート外・symlink 脱出は ok: false)
async function resolveEmbedRef(
  app: FastifyInstance,
  ref: LinkRef,
  docPath: string,
): Promise<{ name: string; rel: string | null; file: ResolvedFile | null }> {
  const libraryPath = app.config.libraryPath;
  if (!ref.markdown) {
    const name = path.posix.basename(ref.target.replaceAll('\\', '/'));
    const rel = app.indexerService.resolveAttachment(ref.target, docPath);
    return { name, rel, file: rel ? await resolveAttachmentFile(libraryPath, rel) : null };
  }

  const decoded = decodeUriPathSegments(ref.target);
  const name = path.posix.basename(decoded.replaceAll('\\', '/'));
  const direct = resolveMarkdownRelPath(folderOfDoc(docPath), decoded);
  if (direct && !isProtectedPath(direct) && !direct.split('/').includes('.trash')) {
    const file = await resolveAttachmentFile(libraryPath, direct);
    if (file.ok) return { name, rel: direct, file };
  }
  // 画面と同じ basename フォールバック(添付索引の名前一致)
  const rel = name ? app.indexerService.resolveAttachment(name, docPath) : null;
  return { name, rel, file: rel ? await resolveAttachmentFile(libraryPath, rel) : null };
}

export function registerAttachmentTools(mcp: McpServer, app: FastifyInstance): void {
  mcp.registerTool(
    'upload_attachment',
    {
      title: '添付ファイルアップロード',
      description:
        'ノートに画像またはPDFを添付ファイルとして保存する。本文への挿入は呼び出し側で行う(戻り値の embed または ![[embedTarget]])',
      inputSchema: {
        docPath: z
          .string()
          .min(1)
          .describe('添付先ノートの相対パス(このノートの位置を基準に保存先が決まる)'),
        fileName: z.string().min(1).describe('元のファイル名(拡張子で形式を判定。例: diagram.png)'),
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
          embedTarget: result.embedTarget,
          embed: `![[${result.embedTarget}]]`,
        });
      } catch (e) {
        return docError(e);
      }
    },
  );

  mcp.registerTool(
    'read_attachment',
    {
      title: '添付ファイル読み取り',
      description:
        'ノートに埋め込まれた添付ファイルを読む。SVGは本文テキスト、画像(png/jpg/jpeg/gif/webp)は画像として返し、PDFなどはメタ情報(name, path, size, mimeType, updatedAt)のみ返す。nameは![[...]]に書かれたままのファイル名で、添付の保存先設定に沿って画面と同じ規則で解決される。上限は画像5MiB・SVG256KiBで、超過時は内容を返さず PAYLOAD_TOO_LARGE',
      inputSchema: {
        docPath: z
          .string()
          .min(1)
          .describe('参照元ノートの相対パス(このノートの位置から添付を解決する)'),
        name: z
          .string()
          .min(1)
          .describe('埋め込みの書き方のままのファイル名(例: image-20261116222509.svg)'),
      },
    },
    async ({ docPath, name }) => {
      if (isInvalidAttachmentName(name)) {
        return toolError({ code: 'INVALID_PATH', message: 'ファイル名の指定が不正です' });
      }
      try {
        await app.docService.getDoc(docPath);
      } catch (e) {
        return docError(e);
      }

      const rel = app.indexerService.resolveAttachment(name, docPath);
      if (!rel) {
        return toolError({ code: 'NOT_FOUND', message: `添付ファイルが見つかりません: ${name}` });
      }
      const file = await resolveAttachmentFile(app.config.libraryPath, rel);
      if (!file.ok) {
        return file.reason === 'INVALID_PATH'
          ? toolError({ code: 'INVALID_PATH', message: 'ライブラリの外を指す添付は読めません' })
          : toolError({ code: 'NOT_FOUND', message: `添付ファイルが見つかりません: ${name}` });
      }

      const ext = path.posix.extname(rel).toLowerCase();
      const kind = classifyAttachment(ext);
      const meta = {
        name: path.posix.basename(rel),
        path: rel,
        size: file.size,
        mimeType: MIME_BY_EXT[ext] ?? 'application/octet-stream',
        updatedAt: file.mtime.toISOString(),
        kind,
      };

      if (kind === 'meta') {
        return toolResult(meta);
      }
      const limit =
        kind === 'image' ? READ_ATTACHMENT_MAX_IMAGE_BYTES : READ_ATTACHMENT_MAX_TEXT_BYTES;
      const tooLarge = () =>
        toolError({
          code: 'PAYLOAD_TOO_LARGE',
          message: `添付ファイルが返却サイズの上限(${limit} バイト)を超えています`,
          limit,
          ...meta,
        });
      if (file.size > limit) return tooLarge();

      let data: Buffer;
      try {
        data = await readFile(file.abs);
      } catch {
        return toolError({ code: 'NOT_FOUND', message: `添付ファイルが見つかりません: ${name}` });
      }
      if (data.length > limit) return tooLarge(); // stat と read の間に増えた場合

      const metaText = { type: 'text' as const, text: JSON.stringify(meta, null, 2) };
      if (kind === 'text') {
        // 本文つきの成功時は structuredContent を付けない(content と形を揃える規約。
        // structuredContent を優先するクライアントで本文が落ちるのを避ける)。メタは content の JSON に残す
        return { content: [{ type: 'text' as const, text: data.toString('utf8') }, metaText] };
      }
      return {
        content: [
          { type: 'image' as const, data: data.toString('base64'), mimeType: meta.mimeType },
          metaText,
        ],
      };
    },
  );

  mcp.registerTool(
    'list_attachments',
    {
      title: '添付ファイル参照一覧',
      description:
        'ノートが埋め込み(![[...]] / ![](...))で参照している添付の一覧(name, path, size, mimeType, exists)を返す。参照先が見つからない場合は exists: false',
      inputSchema: {
        docPath: z.string().min(1).describe('ノートの相対パス'),
      },
    },
    async ({ docPath }) => {
      let body: string;
      try {
        body = (await app.docService.getDoc(docPath)).body;
      } catch (e) {
        return docError(e);
      }

      const attachments: {
        name: string;
        path: string | null;
        size: number | null;
        mimeType: string;
        exists: boolean;
      }[] = [];
      const seen = new Set<string>();
      for (const ref of extractEmbedRefs(body)) {
        const ext = path.posix
          .extname(ref.markdown ? decodeUriPathSegments(ref.target) : ref.target)
          .toLowerCase();
        const mimeType = MIME_BY_EXT[ext];
        if (!mimeType) continue; // 添付以外(ノート埋め込みなど)は対象外

        const { name, rel, file } = await resolveEmbedRef(app, ref, docPath);
        if (rel && file?.ok) {
          if (seen.has(rel)) continue;
          seen.add(rel);
          attachments.push({
            name: path.posix.basename(rel),
            path: rel,
            size: file.size,
            mimeType,
            exists: true,
          });
        } else {
          // 未解決・実体なし・ライブラリ外を指す場合は、外部の情報を出さず exists: false にする
          const key = `?${name.normalize('NFC').toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          attachments.push({ name, path: null, size: null, mimeType, exists: false });
        }
      }
      return toolResult({ docPath, attachments });
    },
  );
}
