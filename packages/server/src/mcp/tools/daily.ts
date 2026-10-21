import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { InvalidDailyNoteSettingsError, ensureDailyNote } from '../../services/daily-note.js';
import { DocLockedError } from '../../services/lock-service.js';
import { formatEntry, insertIntoSection, isValidHeading } from '../daily-append.js';
import { MCP_AUTHOR } from '../server.js';
import { toolError, toolResult as asResult } from '../tool-result.js';

// デイリーノート系ツール(issue #190 / #288)。作成処理は REST と共通の ensureDailyNote を使う。
// req.user が無いため、テンプレ変数の user は固定文字列を使う
const MCP_USER = 'MCP Agent';

function lockedError(e: DocLockedError) {
  return toolError({
    code: 'DOC_LOCKED',
    message: e.message,
    holder: { displayName: e.holder.displayName },
  });
}

function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function registerDailyTools(mcp: McpServer, app: FastifyInstance): void {
  mcp.registerTool(
    'create_daily_note',
    {
      title: '今日のデイリーノート作成',
      description:
        '今日の日付でデイリーノートを作成する。既に存在すればそのパスを返す(created: false)',
      inputSchema: {},
    },
    async () => {
      try {
        return asResult(await ensureDailyNote(app, new Date(), MCP_USER, MCP_AUTHOR, app.log));
      } catch (e) {
        if (e instanceof InvalidDailyNoteSettingsError) throw new Error(e.message);
        throw e;
      }
    },
  );

  mcp.registerTool(
    'append_to_daily_note',
    {
      title: '今日のデイリーノートへ追記',
      description:
        '今日のデイリーノートの指定見出し(既定は「## メモ」)の節の末尾に1件追記する。' +
        'デイリーノートや見出しが無ければ作成する。本文全体の読み書きは不要で、既存の行は書き換えない。' +
        '各件の先頭に「HH:MM [source] 」が付く。箇条書きにしたいときは text を「- 」で始める' +
        '(直前が箇条書きなら同じリストに続き、そうでなければ前の行と空行で区切られる)。' +
        'UIで編集中のノートには書けない(isError、structuredContent.code が DOC_LOCKED)',
      inputSchema: {
        text: z
          .string()
          .refine((v) => v.trim().length > 0, '追記する内容が空です')
          .describe('追記する内容(複数行可)。整形せずそのまま入る'),
        heading: z
          .string()
          .optional()
          .describe('追記先の見出し(ATX形式。既定: "## メモ")。ノートに無ければ末尾に見出しごと追加する'),
        source: z
          .string()
          .refine((v) => !/[\r\n]/.test(v), 'source に改行は含められません')
          .optional()
          .describe('書き込んだエージェント名(例: "Claude Code")。各件の先頭に [source] として付く'),
      },
    },
    async ({ text, heading = '## メモ', source }) => {
      if (!isValidHeading(heading)) {
        return toolError({
          code: 'INVALID_HEADING',
          message: 'heading は「## メモ」のような # で始まる見出し1行で指定してください',
        });
      }

      const now = new Date();
      let daily: { path: string; created: boolean };
      try {
        daily = await ensureDailyNote(app, now, MCP_USER, MCP_AUTHOR, app.log);
      } catch (e) {
        if (e instanceof InvalidDailyNoteSettingsError) throw new Error(e.message);
        throw e;
      }

      const entry = formatEntry(text, { time: hhmm(now), source: source?.trim() || undefined });
      try {
        // 同一パスの追記は docService 側で直列化される。本文は読み書きとも docService の中で完結する
        const saved = await app.docService.appendDocMcp(
          daily.path,
          (body) => insertIntoSection(body, heading, entry),
          MCP_AUTHOR,
        );
        return asResult({ path: daily.path, created: daily.created, updatedAt: saved.updatedAt });
      } catch (e) {
        if (e instanceof DocLockedError) return lockedError(e);
        throw e;
      }
    },
  );
}
