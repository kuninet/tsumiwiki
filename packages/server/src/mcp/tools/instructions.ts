import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildDailyJournalPrompt } from '../prompts/daily-journal.js';
import { loadRecipe, todayString } from '../prompts/recipe.js';
import { buildWorkLogPrompt } from '../prompts/work-log.js';

// 記録の手順を返すツール(issue #298)。
// MCP のプロンプトは人がスラッシュコマンドで呼んだときにしか届かないため、
// 「日誌書いて」と頼まれた AI が自分で手順を取得できるよう、プロンプトと同じ本文をツールでも返す。

export function registerInstructionTools(mcp: McpServer, app: FastifyInstance): void {
  mcp.registerTool(
    'get_record_instructions',
    {
      title: '記録の手順を取得',
      description:
        '「記録して」「ログ残して」「作業ログ」「日誌」「日報」「振り返り」など、作業の記録や1日の振り返りを書くよう頼まれたら、' +
        '書き込む前に必ずこれを呼び、返った手順に従う。' +
        'kind は、いま終わった作業の記録なら work_log、1日の振り返りなら daily_journal',
      inputSchema: {
        kind: z
          .enum(['work_log', 'daily_journal'])
          .describe('work_log: いま終わった作業の記録 / daily_journal: 1日の振り返り'),
        project: z.string().optional().describe('対象プロジェクト名。work_log のときだけ使う'),
      },
    },
    async ({ kind, project }) => {
      const recipe = await loadRecipe(app);
      const today = todayString();
      const instructions =
        kind === 'work_log'
          ? buildWorkLogPrompt({ project, today, recipe })
          : buildDailyJournalPrompt({ today, recipe });
      // 本文をそのまま読めるよう、JSON 化せず content のテキストだけを返す。
      // structuredContent を付けると、それを優先するクライアントで JSON の形で読まれてしまう
      return { content: [{ type: 'text' as const, text: instructions }] };
    },
  );
}
