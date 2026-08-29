import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { createEditorExtensions, roundtripMarkdown } from '../markdown';

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

describe('Markdown リンクの往復保全(issue #207)', () => {
  it.each([
    ['[a](sub/old.png)', '/ を含む相対パス'],
    ['[a](sub/doc.md)', '/ を含む文書への相対パス'],
    ['[a](a/b/c.png)', '複数階層の相対パス'],
    ['[a](./sub/old.png)', './ 始まりの相対パス'],
    ['[a](../up.png)', '../ 始まりの相対パス'],
    ['[a](old.png)', 'ファイル名のみ'],
    ['[a](#anchor)', 'アンカーのみ'],
    ['[a](https://example.com/x?y=1)', '絶対URL'],
    ['[a](mailto:x@example.com)', 'mailto'],
    ['[a](file:///c/x.txt)', 'file スキーム(FR-LINK-02)'],
    ['[a](file://server/share/x.txt)', 'UNC 相当の file スキーム'],
  ])('%s が原文のまま保全される(%s)', (source) => {
    expect(roundtripMarkdown(source)).toBe(source);
  });

  it('title 付きリンクの title が保全される', () => {
    expect(roundtripMarkdown('[説明](old.png "タイトル")')).toBe('[説明](old.png "タイトル")');
    expect(roundtripMarkdown('[説明](sub/old.png "タイトル")')).toBe(
      '[説明](sub/old.png "タイトル")',
    );
  });

  // Markdown をパースした結果に link マークが含まれるか(リンク化されたか)
  function hasLinkMark(markdown: string): boolean {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: markdown,
    });
    try {
      let found = false;
      editor.state.doc.descendants((node) => {
        if (node.marks.some((m) => m.type.name === 'link')) found = true;
      });
      return found;
    } finally {
      editor.destroy();
    }
  }

  it('許可外スキーム(tel: ftp: 等)はリンク化されないが原文は失われない', () => {
    for (const source of ['[a](tel:+81)', '[a](ftp://x/y)', '[a](sms:123)', '[a](xmpp:x@y)']) {
      expect(hasLinkMark(source), source).toBe(false);
      // リテラル化(エスケープ)されるだけで URL 文字列は本文に残る
      expect(roundtripMarkdown(source)).toContain(source.slice(source.indexOf('(') + 1, -1));
    }
  });

  it('data: はリンク・画像ともリテラル化され原文が残る', () => {
    // 画像として許可しても Image 拡張の既定(allowBase64: false)で落ちて原文が消えるため、
    // 許可集合から外してリテラル化する
    expect(hasLinkMark('[a](data:image/png;base64,AAAA)')).toBe(false);
    expect(roundtripMarkdown('![a](data:image/png;base64,AAAA)')).toContain(
      'data:image/png;base64,AAAA',
    );
  });

  it('許可スキームと相対パスはリンクになる', () => {
    expect(hasLinkMark('[a](sub/old.png)')).toBe(true);
    expect(hasLinkMark('[a](file:///c/x.txt)')).toBe(true);
    expect(hasLinkMark('[a](https://example.com)')).toBe(true);
  });

  it('実行系スキームはリンクにならない(XSS 防止)', () => {
    for (const source of [
      '[a](javascript:alert(1))',
      '[a](JAVASCRIPT:alert(1))',
      '[a](vbscript:x)',
      '[a](data:text/html;base64,AAAA)',
      // 実体参照で空白を挟んだ偽装(ブラウザは空白を無視して javascript: と解釈する)
      '[a](java&#9;script:alert(1))',
    ]) {
      expect(hasLinkMark(source), source).toBe(false);
    }
  });
});
