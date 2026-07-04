import { describe, expect, it } from 'vitest';
import { roundtripMarkdown } from '../markdown';

// 往復変換テスト(FR-EDIT-06 / 設計05章5.7)
// 方針: 1回目の変換で正規化差分(記号の統一等)は許容し、
//       2回目以降が完全に安定すること(冪等性)を必須とする。

const fixtures = import.meta.glob('./fixtures/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

describe('往復変換の冪等性(fixtures)', () => {
  for (const [name, source] of Object.entries(fixtures)) {
    it(`${name.replace('./fixtures/', '')} : serialize(parse(x)) が安定する`, () => {
      const pass1 = roundtripMarkdown(source);
      const pass2 = roundtripMarkdown(pass1);
      expect(pass2).toBe(pass1);
    });
  }
});

describe('Obsidian互換記法の原文保全', () => {
  it('wikilinkをそのまま保全する', () => {
    expect(roundtripMarkdown('[[リンク先ページ]] を参照。').trim()).toBe(
      '[[リンク先ページ]] を参照。',
    );
  });

  it('別名付きwikilinkをそのまま保全する', () => {
    expect(roundtripMarkdown('[[フォルダ/ページ|別名表示]] を参照。').trim()).toBe(
      '[[フォルダ/ページ|別名表示]] を参照。',
    );
  });

  it('埋め込み記法をそのまま保全する', () => {
    expect(roundtripMarkdown('画像は ![[screenshot.png]] を参照。').trim()).toBe(
      '画像は ![[screenshot.png]] を参照。',
    );
  });

  it('本文中のインラインタグを保全する', () => {
    expect(roundtripMarkdown('この文書は #タグ と #階層/タグ を含む。').trim()).toBe(
      'この文書は #タグ と #階層/タグ を含む。',
    );
  });

  it('mermaidコードブロックの言語名と内容を保全する', () => {
    const src = '```mermaid\ngraph TD\n  A --> B\n```';
    const out = roundtripMarkdown(src).trim();
    expect(out).toContain('```mermaid');
    expect(out).toContain('A --> B');
  });

  it('dataviewブロックを実行せずそのまま保全する(FR-OBS-08)', () => {
    const src = '```dataview\nTABLE file.name FROM #プロジェクト\n```';
    const out = roundtripMarkdown(src).trim();
    expect(out).toContain('```dataview');
    expect(out).toContain('TABLE file.name FROM #プロジェクト');
  });

  it('HTMLブロックを原文のまま保全する', () => {
    const src = '<div class="note">\n中身は<b>そのまま</b>。\n</div>';
    const out = roundtripMarkdown(src);
    expect(out).toContain('<div class="note">');
    expect(out).toContain('中身は<b>そのまま</b>。');
    expect(out).toContain('</div>');
  });
});

describe('基本記法の保全', () => {
  const cases: Array<[string, string]> = [
    ['見出し', '# 見出し1'],
    ['太字', '**太字**を含む。'],
    ['斜体', '*斜体*を含む。'],
    ['打消し', '~~打消し~~を含む。'],
    ['インラインコード', '`code`を含む。'],
    ['箇条書き', '- 項目1\n- 項目2'],
    ['番号付きリスト', '1. 項目1\n2. 項目2'],
    ['チェックリスト', '- [ ] 未完了\n- [x] 完了'],
    ['引用', '> 引用文。'],
    ['リンク', '[リンク](https://example.com) を含む。'],
    ['標準画像', '![alt](images/a.png) を含む。'],
  ];

  for (const [label, src] of cases) {
    it(`${label}: 原文と一致する`, () => {
      expect(roundtripMarkdown(src).trim()).toBe(src);
    });
  }
});
