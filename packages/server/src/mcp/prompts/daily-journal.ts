import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildRecipeSection, loadRecipe, todayString, type Recipe } from './recipe.js';

// プロンプト daily_journal(issue #298)。
// 今日の作業ログ(work_log が作るノート)と今日のデイリーノートを読み、1日の振り返りをデイリーノートへ追記する。
// 手順の骨格はここに持ち、見出しなどの運用固有の決まりは work_log と同じレシピノートに書く。

// レシピが無いときの文。保存先はデイリーノートで決まっているので、既定の手順で書く
const RECIPE_MISSING_NOTE = '既定の手順どおりに書く(見出しは `## 振り返り`)。';

export interface DailyJournalPromptInput {
  // サーバーのローカル日付(YYYY-MM-DD)
  today: string;
  recipe: Recipe;
}

// 本文を組み立てる純粋関数。{{...}} のような未解決の穴を残さない
export function buildDailyJournalPrompt({ today, recipe }: DailyJournalPromptInput): string {
  return [
    'あなたは記録係です。今日1日の作業を振り返り、TsumiWiki のデイリーノートに書いてください。',
    '',
    `- 今日の日付: ${today}`,
    '',
    '## 手順',
    '',
    '1. 材料を集める。',
    `   - \`find_notes_by_property\` で、key に \`date\`、value に \`${today}\` を指定して探す。見つかったノートを \`read_note\` で読み、フロントマターの type が \`work-log\` のものだけを使う。`,
    '   - `create_daily_note`(引数なし)で今日のデイリーノートのパスを得て、`read_note` で読む。既にある日は、そのパスが返るだけ。無い日は、このときノートが作られる。',
    '   - デイリーノートの要約にリンクされている作業ログも読む(フロントマターの無い古いログを拾うため)。',
    '   - 今のセッションの会話も材料にする。',
    '2. 振り返りの下書きを作る。項目は次の4つ。',
    '   - 今日の成果: プロジェクトごとに数行',
    '   - 判断したこと',
    '   - 明日以降に残ったこと',
    '   - 所感: 本人の発言があればそれを書き、なければ書かない',
    '   - 該当する項目だけを書く。',
    '   - 各成果の末尾に、作業ログへのリンクを付ける。形は `[[作業ログのパスから .md を除いたもの]]`。',
    '   - 数字・固有名詞・件数は、作業ログか本人の発言で確かめられたものだけを書き、推測で埋めない。',
    '3. 下書きを本人に見せ、承認を得る。承認の前には書き込まない。',
    '4. `append_to_daily_note` で書き込む。',
    '   - `heading` は `## 振り返り` にする。レシピに指定があれば、それに従う。',
    '   - `source` にはエージェント名を渡す。時刻と署名はツールが付けるので、本文には書かない。',
    '   - 本文は `- ` の箇条書きで始め、見出しの行から始めない(1行目に時刻が付くため)。項目名は `**今日の成果**` のように太字にする。',
    '   - 4つの項目は、1回の呼び出しでまとめて書く。',
    '   - 今日の振り返りが既にその見出しにあるときは、重ねて書かず、本人に確認する。',
    '5. 書いたことを本人に報告する。',
    '',
    buildRecipeSection(recipe, RECIPE_MISSING_NOTE),
  ].join('\n');
}

export function registerDailyJournalPrompt(mcp: McpServer, app: FastifyInstance): void {
  // 引数は持たない(対象は今日だけ)。argsSchema を渡さないと SDK は arguments を検証しない
  mcp.registerPrompt(
    'daily_journal',
    {
      title: '今日の振り返りを書く',
      description: '今日の作業ログとデイリーノートを読み、1日の振り返りをデイリーノートに追記する',
    },
    async () => {
      const recipe = await loadRecipe(app);
      const text = buildDailyJournalPrompt({ today: todayString(), recipe });
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
    },
  );
}
