import type { FastifyInstance } from 'fastify';
import { formatDate } from '@tsumiwiki/shared';
import { DocNotFoundError } from '../../services/doc-service.js';

// 記録系プロンプト(work_log / daily_journal)で共通に使うレシピノートの読み込みと節の組み立て。
// レシピノートは両方のプロンプトで同じものを使う(環境変数 MCP_WORK_LOG_RECIPE)。

// レシピノートの読み込み結果。読めなかったときは missing: true
export type Recipe = { path: string; body: string } | { path: string; missing: true };

// サーバーのローカル日付(YYYY-MM-DD)
export function todayString(): string {
  return formatDate(new Date(), 'YYYY-MM-DD');
}

export async function loadRecipe(app: FastifyInstance): Promise<Recipe> {
  const path = app.config.mcpWorkLogRecipe;
  try {
    const doc = await app.docService.getDoc(path);
    return { path, body: doc.body };
  } catch (e) {
    // 不正なパスやノート無し・読み取り失敗はすべて「レシピ無し」として骨格だけで動かす。
    // ノートが無いのは想定内なので、それ以外の例外だけ記録する
    if (!(e instanceof DocNotFoundError)) {
      app.log.warn({ err: e, path }, '記録用レシピノートを読めませんでした');
    }
    return { path, missing: true };
  }
}

// レシピを優先する範囲。両プロンプトで共通
const RECIPE_SCOPE = '保存先・命名規則・見出し・項目';

// work_log 用: レシピが無いときの後半の文
export const RECIPE_MISSING_ASK_LOCATION =
  '保存先のフォルダとファイル名は、本人に確認してから決める。';

// レシピの節(見出し・優先の一文・本文/見つからない文面)を作る。
// 本文が空(空白のみ)のレシピは、無いものとして扱う。
// whenMissing は、レシピが見つからないときに「見つからない」の後ろへ続ける文(プロンプトごとに書き分ける)
export function buildRecipeSection(recipe: Recipe, whenMissing: string): string {
  const recipeBody = 'body' in recipe ? recipe.body.trim() : '';
  if (recipeBody !== '') {
    return [
      `## レシピ(${recipe.path})`,
      '',
      `${RECIPE_SCOPE}について、上の手順とレシピが食い違うときは、レシピを優先する。`,
      '',
      recipeBody,
    ].join('\n');
  }
  return [
    '## レシピ',
    '',
    `レシピノート ${recipe.path} が見つからない(または本文が空)。${whenMissing}`,
  ].join('\n');
}
