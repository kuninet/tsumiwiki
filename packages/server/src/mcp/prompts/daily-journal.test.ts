import { describe, expect, it } from 'vitest';
import { buildDailyJournalPrompt } from './daily-journal.js';
import type { Recipe } from './recipe.js';

const MISSING: Recipe = { path: '作業ログの書き方.md', missing: true };
const FOUND: Recipe = {
  path: '作業ログの書き方.md',
  body: '# 作業ログの書き方\n\n振り返りの見出しは `## 今日のまとめ` にする。',
};

describe('buildDailyJournalPrompt', () => {
  it('今日の日付が入り、探す条件にも使われる', () => {
    const text = buildDailyJournalPrompt({ today: '2026-11-01', recipe: MISSING });
    expect(text).toContain('今日の日付: 2026-11-01');
    expect(text).toContain('`2026-11-01` を指定して探す');
  });

  it('手順のキーワードが含まれる', () => {
    const text = buildDailyJournalPrompt({ today: '2026-11-01', recipe: MISSING });
    expect(text).toContain('`find_notes_by_property`');
    expect(text).toContain('`work-log`');
    expect(text).toContain('`create_daily_note`');
    expect(text).toContain('`append_to_daily_note`');
    expect(text).toContain('承認の前には書き込まない');
    expect(text).toContain('`## 振り返り`');
    expect(text).toContain('[[作業ログのパスから .md を除いたもの]]');
    expect(text).toContain('推測で埋めない');
    expect(text).toContain('重ねて書かず、本人に確認する');
  });

  it('手順4に、append_to_daily_note の書式に関する指示が入る', () => {
    const text = buildDailyJournalPrompt({ today: '2026-11-01', recipe: MISSING });
    expect(text).toContain('本文は `- ` の箇条書きで始め、見出しの行から始めない');
    expect(text).toContain('`**今日の成果**` のように太字にする');
    expect(text).toContain('時刻と署名はツールが付けるので、本文には書かない');
    expect(text).toContain('4つの項目は、1回の呼び出しでまとめて書く');
  });

  it('材料集めに、create_daily_note の副作用と古い作業ログの拾い方が入る', () => {
    const text = buildDailyJournalPrompt({ today: '2026-11-01', recipe: MISSING });
    expect(text).toContain('無い日は、このときノートが作られる');
    expect(text).toContain('デイリーノートの要約にリンクされている作業ログも読む');
  });

  it('レシピがあるとき、パスと本文が入り、レシピ優先の旨が書かれる', () => {
    const text = buildDailyJournalPrompt({ today: '2026-11-01', recipe: FOUND });
    expect(text).toContain('## レシピ(作業ログの書き方.md)');
    expect(text).toContain('振り返りの見出しは `## 今日のまとめ` にする。');
    expect(text).toContain('保存先・命名規則・見出し・項目について、上の手順とレシピが食い違うときは、レシピを優先する。');
    expect(text).not.toContain('見つからない');
  });

  it('レシピがないとき、パスを示して本人に確認する旨が入る', () => {
    const text = buildDailyJournalPrompt({ today: '2026-11-01', recipe: MISSING });
    expect(text).toContain('レシピノート 作業ログの書き方.md が見つからない');
    expect(text).toContain('既定の手順どおりに書く(見出しは `## 振り返り`)。');
    expect(text).not.toContain('本人に確認してから決める');
    expect(text).not.toContain('レシピを優先する');
  });

  it('本文が空・空白のみのレシピは、レシピ無しとして扱う', () => {
    for (const body of ['', '  \n\n  ']) {
      const text = buildDailyJournalPrompt({ today: '2026-11-01', recipe: { path: 'a.md', body } });
      expect(text).toContain('レシピノート a.md が見つからない');
      expect(text).not.toContain('## レシピ(a.md)');
    }
  });

  it('どの場合も {{ を含まない', () => {
    for (const recipe of [MISSING, FOUND, { path: 'a.md', body: '' }]) {
      expect(buildDailyJournalPrompt({ today: '2026-11-01', recipe })).not.toContain('{{');
    }
  });
});
