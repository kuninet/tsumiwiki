import { describe, expect, it } from 'vitest';
import type { Recipe } from './recipe.js';
import { buildWorkLogPrompt } from './work-log.js';

const MISSING: Recipe = { path: '作業ログの書き方.md', missing: true };
const FOUND: Recipe = {
  path: '作業ログの書き方.md',
  body: '# 作業ログの書き方\n\n保存先は 作業ログ/{プロジェクト}/ にする。',
};

describe('buildWorkLogPrompt', () => {
  it('project を指定するとその名前と今日の日付が入る', () => {
    const text = buildWorkLogPrompt({ project: 'tsumiwiki', today: '2026-11-01', recipe: MISSING });
    expect(text).toContain('対象プロジェクト: tsumiwiki');
    expect(text).toContain('今日の日付: 2026-11-01');
  });

  it('project の前後の空白は除かれる', () => {
    const text = buildWorkLogPrompt({ project: '  X  ', today: '2026-11-01', recipe: MISSING });
    expect(text).toContain('対象プロジェクト: X\n');
  });

  it('project が未指定・空文字・空白のみのときは「指定なし」と書く', () => {
    for (const project of [undefined, '', '   ']) {
      const text = buildWorkLogPrompt({ project, today: '2026-11-01', recipe: MISSING });
      expect(text).toContain('対象プロジェクト: 指定なし(作業内容から特定する)');
    }
  });

  it('レシピがあるとき、パスと本文が入り、レシピ優先の旨が書かれる', () => {
    const text = buildWorkLogPrompt({ today: '2026-11-01', recipe: FOUND });
    expect(text).toContain('## レシピ(作業ログの書き方.md)');
    expect(text).toContain('保存先は 作業ログ/{プロジェクト}/ にする。');
    expect(text).toContain('レシピを優先する');
    expect(text).not.toContain('見つからない');
  });

  it('レシピがないとき、パスを示して本人に確認する旨が入る', () => {
    const text = buildWorkLogPrompt({ today: '2026-11-01', recipe: MISSING });
    expect(text).toContain('レシピノート 作業ログの書き方.md が見つからない');
    expect(text).toContain('本人に確認してから決める');
    expect(text).not.toContain('レシピを優先する');
  });

  it('本文が空・空白のみのレシピは、レシピ無しとして扱う', () => {
    for (const body of ['', '  \n\n  ']) {
      const text = buildWorkLogPrompt({ today: '2026-11-01', recipe: { path: 'a.md', body } });
      expect(text).toContain('レシピノート a.md が見つからない');
      expect(text).not.toContain('## レシピ(a.md)');
      expect(text).not.toContain('レシピを優先する');
    }
  });

  it('project の指定の有無で、対象プロジェクトの行と例の project 行だけが変わる', () => {
    const base = { today: '2026-11-01', recipe: MISSING };
    const without = buildWorkLogPrompt(base);
    const withProject = buildWorkLogPrompt({ ...base, project: 'tsumiwiki' });
    expect(without).toContain('対象プロジェクト: 指定なし(作業内容から特定する)');
    expect(withProject).toContain('対象プロジェクト: tsumiwiki');
    expect(withProject).not.toContain('指定なし(作業内容から特定する)');
    expect(
      without
        .replace('指定なし(作業内容から特定する)', 'tsumiwiki')
        .replace('project: <プロジェクト名>', 'project: tsumiwiki'),
    ).toBe(withProject);
  });

  it('手順に承認の範囲・パス重複時の確認・wikilink の形が書かれている', () => {
    const text = buildWorkLogPrompt({ today: '2026-11-01', recipe: MISSING });
    expect(text).toContain('対象プロジェクトが指定されていなければ、作業内容から特定する');
    expect(text).toContain('デイリーノートに足す要約を本人に見せ、承認を得る');
    expect(text).toContain('承認の前には、どちらのノートにも書き込まない');
    expect(text).toContain('同じパスのノートがあってエラーになったら、別のファイル名を本人に確認する');
    expect(text).toContain('[[作ったノートのパスから .md を除いたもの]]');
  });

  it('手順4に作業ログのフロントマターの指示があり、今日の日付が入る', () => {
    const text = buildWorkLogPrompt({ project: 'tsumiwiki', today: '2026-11-01', recipe: MISSING });
    expect(text).toContain('type: work-log');
    expect(text).toContain('date: 2026-11-01');
    expect(text).toContain('project: tsumiwiki');
    expect(text).not.toContain('<今日の日付>');
    expect(text).not.toContain('<プロジェクト名>');
    // project が無いときだけ、例は <プロジェクト名> になる
    const noProject = buildWorkLogPrompt({ today: '2026-11-01', recipe: MISSING });
    expect(noProject).toContain('project: <プロジェクト名>');
  });

  it('手順に create_note と append_to_daily_note が含まれる', () => {
    const text = buildWorkLogPrompt({ today: '2026-11-01', recipe: MISSING });
    expect(text).toContain('`create_note`');
    expect(text).toContain('`append_to_daily_note`');
  });

  it('どの場合も {{ を含まない', () => {
    for (const project of [undefined, '', '   ', 'X']) {
      for (const recipe of [MISSING, { path: 'a.md', body: '' }]) {
        const text = buildWorkLogPrompt({ project, today: '2026-11-01', recipe });
        expect(text).not.toContain('{{');
      }
    }
  });
});
