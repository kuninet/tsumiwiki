import { describe, expect, it } from 'vitest';
import { buildRecipeSection, todayString } from './recipe.js';

describe('buildRecipeSection', () => {
  it('本文があるとき、見出し・優先の一文(範囲つき)・本文が入る', () => {
    const text = buildRecipeSection({ path: 'r.md', body: '\n本文です\n' }, '無いとき');
    expect(text).toBe(
      '## レシピ(r.md)\n\n保存先・命名規則・見出し・項目について、上の手順とレシピが食い違うときは、レシピを優先する。\n\n本文です',
    );
  });

  it('missing・本文が空白のみのときは、見つからない旨の文面になる', () => {
    for (const recipe of [
      { path: 'r.md', missing: true as const },
      { path: 'r.md', body: ' \n ' },
    ]) {
      const text = buildRecipeSection(recipe, '無いときの文。');
      expect(text).toContain('レシピノート r.md が見つからない(または本文が空)。無いときの文。');
      expect(text).not.toContain('レシピを優先する');
    }
  });
});

describe('todayString', () => {
  it('YYYY-MM-DD 形式を返す', () => {
    expect(todayString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
