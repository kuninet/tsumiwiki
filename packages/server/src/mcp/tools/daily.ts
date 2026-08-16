import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expandTemplateVariables, formatDate } from '@tsumiwiki/shared';
import { resolveInLibrary } from '../../lib/paths.js';
import { DocConflictError } from '../../services/doc-service.js';
import { MCP_AUTHOR } from '../server.js';
import { toolResult as asResult } from '../tool-result.js';

// デイリーノート作成ツール(issue #190)。routes/daily-notes.tsとほぼ同じロジックだが
// req.userが無いため、テンプレ変数のuserは固定文字列を使う

function defaultDailyNoteBody(now: Date, title: string): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `---\ndate: ${yyyy}-${mm}-${dd}\n---\n\n# ${title}\n\n`;
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
      const { settings } = await app.librarySettingsService.get();
      const now = new Date();
      const title = formatDate(now, settings.dailyNotes.filenamePattern);
      if (!title) {
        throw new Error('ファイル名パターンが不正です。ライブラリ設定を確認してください');
      }
      const relPath = settings.dailyNotes.folder
        ? `${settings.dailyNotes.folder}/${title}.md`
        : `${title}.md`;

      try {
        const existing = await app.docService.getDoc(relPath);
        return asResult({ path: existing.path, created: false });
      } catch {
        // 存在しない → テンプレを読んで作成する
      }

      let body: string;
      if (settings.dailyNotes.template) {
        try {
          const tmplAbs = resolveInLibrary(app.config.libraryPath, settings.dailyNotes.template);
          const raw = await readFile(tmplAbs, 'utf8');
          body = expandTemplateVariables(
            raw,
            { date: now, title, user: 'MCP Agent' },
            { stripCursor: true },
          );
        } catch (e) {
          app.log.warn(
            { err: e, template: settings.dailyNotes.template },
            'デイリーノート用テンプレートを読み込めませんでした。既定本文で作成します',
          );
          body = defaultDailyNoteBody(now, title);
        }
      } else {
        body = defaultDailyNoteBody(now, title);
      }

      try {
        const created = await app.docService.createDocWithContent(relPath, body, MCP_AUTHOR);
        return asResult({ path: created.path, created: true });
      } catch (e) {
        if (e instanceof DocConflictError) {
          const existing = await app.docService.getDoc(relPath);
          return asResult({ path: existing.path, created: false });
        }
        throw e;
      }
    },
  );
}
