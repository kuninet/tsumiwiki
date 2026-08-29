import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { createEditorExtensions, roundtripMarkdown, withHeadlessEditor } from '../markdown';

// issue #235: 表セル内のエスケープ済みパイプ(\|)が往復で失われセルが分割される、
// および関連の2件(セル内インラインコードの生パイプ・テキストを含まないセルの消失)の回帰テスト。
//
// markdown-itのGFM表(escapedSplit)はコードスパン等の文脈を考慮せず、バックスラッシュで
// エスケープされていない`|`を全てセル区切りとして扱う。そのため往復を保つには、セル内容に
// 現れる`|`は(コードスパンの中であっても)全てシリアライズ時に`\|`へエスケープする必要がある
// (実測で確認済み。table-markdown.tsのコメント参照)。

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('セル内エスケープ済みパイプの往復(#235-1)', () => {
  it('| a\\|b | が冪等に往復する', () => {
    const md = '| A |\n| --- |\n| a\\|b |\n';
    const pass1 = roundtripMarkdown(md);
    expect(roundtripMarkdown(pass1)).toBe(pass1);
    // \が失われて | a|b | にならないこと(セル分割の原因になる)
    expect(pass1).toContain('a\\|b');
  });

  it('再パース後もセルが1つで、テキストが a|b のまま失われない', () => {
    const md = '| A |\n| --- |\n| a\\|b |\n';
    const pass1 = roundtripMarkdown(md);
    const pass2Text = withCellText(pass1);
    expect(pass2Text).toEqual(['A', 'a|b']);
  });
});

describe('セル内インラインコードの生パイプの往復(#235-2)', () => {
  it('エスケープ済み `{a \\| b}` を含むセルが冪等に往復し、内容が失われない', () => {
    // markdown-itのescapedSplitはコードスパンの中身を区別しないため、コードスパン内で
    // パイプを保持したい場合は元のMarkdown上でも\|とエスケープされている必要がある
    // (実際にdocs/設計/03_API設計.mdもこの形で書かれている)
    const md = '| A |\n| --- |\n| `{a \\| b}` |\n';
    const pass1 = roundtripMarkdown(md);
    expect(roundtripMarkdown(pass1)).toBe(pass1);
    expect(pass1).toContain('{a \\| b}');
    const texts = withCellText(pass1);
    expect(texts).toEqual(['A', '{a | b}']);
  });

  it('エディタ上で直接入力した(生の|を持つ)インラインコードが初回保存でエスケープされる', () => {
    // ペーストや直接入力ではProseMirrorのドキュメントに生の"|"を含むcode markテキストが
    // そのまま入る。この状態からの最初のシリアライズで既にエスケープされる必要がある
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  attrs: { colspan: 1, rowspan: 1, colwidth: null },
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1, colwidth: null },
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: '{a | b}', marks: [{ type: 'code' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const pass1 = serializeDoc(doc);
    expect(pass1).toContain('{a \\| b}');
    expect(roundtripMarkdown(pass1)).toBe(pass1);
    expect(withCellText(pass1)).toEqual(['A', '{a | b}']);
  });

  it('docs/設計/03_API設計.md の壊れる実例行が冪等に往復する', () => {
    const line =
      '| GET | `/api/docs?path=` | 文書取得。`{path, frontmatter, body, updatedAt, lock: {userId, displayName} \\| null}` |';
    const md = `| メソッド | パス | 説明 |\n| --- | --- | --- |\n${line}\n`;
    const pass1 = roundtripMarkdown(md);
    expect(roundtripMarkdown(pass1)).toBe(pass1);
    // 「| null}」を含むセル末尾が失われないこと(#235コメントで報告された実害)
    const texts = withCellText(pass1);
    expect(texts.at(-1)).toContain('| null}');
  });
});

describe('テキストを含まないセルの往復(#235-3)', () => {
  it('hardBreakのみのセル(<br>)が保存で消えない', () => {
    const md = '| A |\n| --- |\n| <br> |\n';
    const pass1 = roundtripMarkdown(md);
    expect(pass1).toContain('<br>');
    expect(roundtripMarkdown(pass1)).toBe(pass1);
  });

  it('画像のみのセル(![alt](x.png))が保存で消えない', () => {
    const md = '| A |\n| --- |\n| ![alt](x.png) |\n';
    const pass1 = roundtripMarkdown(md);
    expect(pass1).toContain('![alt](x.png)');
    expect(roundtripMarkdown(pass1)).toBe(pass1);
  });

  it('埋め込みのみのセル(![[shot.png]])が保存で消えない', () => {
    const md = '| A |\n| --- |\n| ![[shot.png]] |\n';
    const pass1 = roundtripMarkdown(md);
    expect(pass1).toContain('![[shot.png]]');
    expect(roundtripMarkdown(pass1)).toBe(pass1);
  });

  it('本当に空のセルは従来どおり空のまま(回帰)', () => {
    const md = '| A | B |\n| --- | --- |\n| x |  |\n';
    const pass1 = roundtripMarkdown(md);
    expect(roundtripMarkdown(pass1)).toBe(pass1);
    const texts = withCellText(pass1);
    expect(texts).toEqual(['A', 'B', 'x', '']);
  });
});

describe('既存の表の挙動が変わらない(回帰)', () => {
  it('通常の表(テキストのみ)が原文のまま安定する', () => {
    const md = '| 列A | 列B |\n| --- | --- |\n| あ | い |\n| う | え |\n';
    const pass1 = roundtripMarkdown(md);
    expect(pass1.trim()).toBe(md.trim());
    expect(roundtripMarkdown(pass1)).toBe(pass1);
  });

  it('マーク付きセル(太字・リンク)が冪等', () => {
    const md = '| A |\n| --- |\n| **太字** と [リンク](x.md) |\n';
    const pass1 = roundtripMarkdown(md);
    expect(roundtripMarkdown(pass1)).toBe(pass1);
    expect(pass1).toContain('**太字**');
    expect(pass1).toContain('[リンク](x.md)');
  });

  it('セル内改行(<br>)が冪等(#229の回帰)', () => {
    const md = '| A |\n| --- |\n| 1行目<br>2行目 |\n';
    const pass1 = roundtripMarkdown(md);
    expect(pass1).toContain('1行目<br>2行目');
    expect(roundtripMarkdown(pass1)).toBe(pass1);
  });

  it('ヘッダ行なし等の表はHTML表フォールバックのまま維持される', () => {
    // colspanを持つセルはisMarkdownSerializableの条件を満たさずHTML表になる(既定の挙動)
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  attrs: { colspan: 2, rowspan: 1, colwidth: null },
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'AB' }] }],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1, colwidth: null },
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
                },
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1, colwidth: null },
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'y' }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    const md = serializeDoc(doc);
    // isMarkdownSerializable相当の判定を満たさない表はGFMパイプ表ではなくHTML表として出力される
    expect(md).toContain('<table');
    expect(md).toContain('colspan="2"');
  });
});

describe('実文書スイープ: docs/設計/03_API設計.md', () => {
  it('往復が冪等で、パイプを含むセル内容が失われない', () => {
    const path = resolve(__dirname, '../../../../../docs/設計/03_API設計.md');
    const source = readFileSync(path, 'utf-8');
    const pass1 = roundtripMarkdown(source);
    const pass2 = roundtripMarkdown(pass1);
    expect(pass2).toBe(pass1);
    expect(pass1).toContain('| null}');
  });
});

// markdown文字列を再パースし、表内の各セル(tableCell/tableHeader)のテキストを配列で返す
function withCellText(markdown: string): string[] {
  const editor = new Editor({
    extensions: createEditorExtensions({ nodeViews: false }),
    content: markdown,
  });
  try {
    const texts: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
        texts.push(node.textContent);
        return false;
      }
      return true;
    });
    return texts;
  } finally {
    editor.destroy();
  }
}

// ProseMirrorのdoc JSONを直接シリアライズする(HTMLフォールバック等、markdown経由では
// 再現しづらいノード構造を検証するためのヘルパー)
function serializeDoc(doc: object): string {
  return withHeadlessEditor(
    doc as never,
    (editor) => editor.storage.markdown.getMarkdown() as string,
  );
}
