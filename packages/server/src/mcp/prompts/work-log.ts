import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatDate } from '@tsumiwiki/shared';
import { z } from 'zod';
import { DocNotFoundError } from '../../services/doc-service.js';

// プロンプト work_log(issue #296)。
// 手順の骨格はここに持ち、フォルダ・命名規則などの運用固有の決まりは Wiki のレシピノートに書く。
// prompts/get のたびにサーバーがレシピノートを読み、本文をメッセージへ差し込む。

// レシピノートの読み込み結果。読めなかったときは missing: true
export type WorkLogRecipe = { path: string; body: string } | { path: string; missing: true };

export interface WorkLogPromptInput {
  project?: string;
  // サーバーのローカル日付(YYYY-MM-DD)
  today: string;
  recipe: WorkLogRecipe;
}

// 本文を組み立てる純粋関数。{{...}} のような未解決の穴を残さない
export function buildWorkLogPrompt({ project, today, recipe }: WorkLogPromptInput): string {
  const projectLabel = project?.trim() || '指定なし(作業内容から特定する)';

  // 本文が空(空白のみ)のレシピは、無いものとして扱う
  const recipeBody = 'body' in recipe ? recipe.body.trim() : '';
  const recipeSection =
    recipeBody !== ''
      ? [
          `## レシピ(${recipe.path})`,
          '',
          '保存先・命名規則・見出し・項目について、上の手順とレシピが食い違うときは、レシピを優先する。',
          '',
          recipeBody,
        ].join('\n')
      : [
          '## レシピ',
          '',
          `レシピノート ${recipe.path} が見つからない(または本文が空)。保存先のフォルダとファイル名は、本人に確認してから決める。`,
        ].join('\n');

  return [
    'あなたは作業の記録係です。いま終わった作業を、TsumiWiki に記録してください。',
    '',
    `- 対象プロジェクト: ${projectLabel}`,
    `- 今日の日付: ${today}`,
    '',
    '## 手順',
    '',
    '1. 対象プロジェクトが指定されていなければ、作業内容から特定する。決められないときは本人に聞く。',
    '2. 会話とツールの結果から、作業ログの下書きを作る。',
    '   - 数字・固有名詞・件数は、ツールの結果か本人の発言で確かめられたものだけを書き、推測で埋めない。確かめられないものは「未確認」と書く。',
    '   - 項目は「やったこと/決めたこと(理由も1行)/数字・結果/残件/教訓」。該当する項目だけを書く。',
    '3. 作業ログの下書き、保存先のパス、デイリーノートに足す要約を本人に見せ、承認を得る。承認の前には、どちらのノートにも書き込まない。',
    '4. `create_note` で、作業ログを新しいノートとして作る。既存のノートに追記したり、上書きしたりしない。',
    '   - 同じパスのノートがあってエラーになったら、別のファイル名を本人に確認する。',
    '5. `append_to_daily_note` で、今日のデイリーノートに3〜5行の要約を足す。',
    '   - 末尾に、作ったノートへのリンクを付ける。形は `[[作ったノートのパスから .md を除いたもの]]`。例: `[[フォルダ/2026-11-01 作業の要約]]`',
    '   - `source` にはエージェント名を渡す。時刻と署名はツールが付けるので、本文には書かない。',
    '6. 作ったノートのパスを本人に報告する。',
    '',
    recipeSection,
  ].join('\n');
}

async function loadRecipe(app: FastifyInstance): Promise<WorkLogRecipe> {
  const path = app.config.mcpWorkLogRecipe;
  try {
    const doc = await app.docService.getDoc(path);
    return { path, body: doc.body };
  } catch (e) {
    // 不正なパスやノート無し・読み取り失敗はすべて「レシピ無し」として骨格だけで動かす。
    // ノートが無いのは想定内なので、それ以外の例外だけ記録する
    if (!(e instanceof DocNotFoundError)) {
      app.log.warn({ err: e, path }, 'work_log: レシピノートを読めませんでした');
    }
    return { path, missing: true };
  }
}

export function registerWorkLogPrompt(mcp: McpServer, app: FastifyInstance): void {
  mcp.registerPrompt(
    'work_log',
    {
      title: '作業ログを書く',
      description:
        'いま終わった作業について、プロジェクト別の作業ログノートに詳細を新規作成し、今日のデイリーノートに要約とリンクを追記する',
      argsSchema: {
        project: z
          .string()
          .optional()
          .describe('対象プロジェクト名。省略時はAIが作業内容から特定する'),
      },
    },
    async ({ project }) => {
      const recipe = await loadRecipe(app);
      const text = buildWorkLogPrompt({
        project,
        today: formatDate(new Date(), 'YYYY-MM-DD'),
        recipe,
      });
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
    },
  );
}
