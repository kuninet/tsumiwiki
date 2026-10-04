import { describe, expect, it } from 'vitest';
import { roundtripMarkdown, withHeadlessEditor } from '../markdown';

describe('数式パース・往復テスト (R系)', () => {
  it('R1: インライン数式 $x^2$ と $a_b$', () => {
    const src = '$x^2$ と $a_b$';
    expect(roundtripMarkdown(src).trim()).toBe(src);
    withHeadlessEditor(src, (editor) => {
      const types = (editor.getJSON().content?.[0]?.content ?? []).map((n) => n.type);
      expect(types).toEqual(['mathInline', 'text', 'mathInline']);
    });
  });

  it('R2: バックスラッシュが倍化しない (\\alpha_1 + \\beta_2)', () => {
    const src = '$\\alpha_1 + \\beta_2$';
    expect(roundtripMarkdown(src).trim()).toBe(src);
  });

  it('R3: 改行が潰れないブロック数式 ($$\\nE=mc^2\\n$$)', () => {
    const src = '$$\nE=mc^2\n$$';
    expect(roundtripMarkdown(src).trim()).toBe(src);
  });

  it('R4: 複数行・\\\\ 保持', () => {
    const src = '$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$';
    expect(roundtripMarkdown(src).trim()).toBe(src);
  });

  it('R5: 1行形式 $$x$$ は1回目で正規化され2回目以降冪等', () => {
    const src = '$$x$$';
    const pass1 = roundtripMarkdown(src).trim();
    expect(pass1).toBe('$$\nx\n$$');
    const pass2 = roundtripMarkdown(pass1).trim();
    expect(pass2).toBe(pass1);
  });

  it('R6: 価格表記 ($5 と $10) は数式にならない', () => {
    const src = '価格は $5 と $10 です';
    expect(roundtripMarkdown(src).trim()).toBe(src);
    withHeadlessEditor(src, (editor) => {
      const types = (editor.getJSON().content?.[0]?.content ?? []).map((n) => n.type);
      expect(types).toEqual(['text']);
    });
  });

  it('R7: インラインコード `$x$` はコードのまま', () => {
    const src = '`$x$`';
    expect(roundtripMarkdown(src).trim()).toBe(src);
    withHeadlessEditor(src, (editor) => {
      const marks = editor.getJSON().content?.[0]?.content?.[0]?.marks?.map((m) => m.type);
      expect(marks).toEqual(['code']);
    });
  });

  it('R8: コードブロック内の $$y$$ はコードブロックのまま', () => {
    const src = '```\n$$y$$\n```';
    expect(roundtripMarkdown(src).trim()).toBe(src);
  });

  it('R9: 内側に空白がある $ x $ はテキストのまま', () => {
    const src = '$ x $';
    expect(roundtripMarkdown(src).trim()).toBe(src);
    withHeadlessEditor(src, (editor) => {
      const types = (editor.getJSON().content?.[0]?.content ?? []).map((n) => n.type);
      expect(types).toEqual(['text']);
    });
  });

  it('R10: リスト・引用内のブロック数式', () => {
    const listSrc = '- 項目\n  $$\n  x\n  $$';
    const pass1 = roundtripMarkdown(listSrc);
    const pass2 = roundtripMarkdown(pass1);
    expect(pass2).toBe(pass1);

    const quoteSrc = '> $$\n> x\n> $$';
    const q1 = roundtripMarkdown(quoteSrc);
    const q2 = roundtripMarkdown(q1);
    expect(q2).toBe(q1);
  });

  it('R11: $a*b*c$ / $a_b_c$ は強調にならず原文どおり', () => {
    const src = '$a*b*c$ と $a_b_c$';
    expect(roundtripMarkdown(src).trim()).toBe(src);
  });

  it('R12: 段落途中の $$x$$ はブロック化しない', () => {
    const src = '文中 $$x$$ 文中';
    expect(roundtripMarkdown(src).trim()).toBe(src);
  });

  it('R13: $x$ を含む表セルは表として保全', () => {
    const src = '| 項目 | 式 |\n| --- | --- |\n| 面積 | $S = \\pi r^2$ |';
    const pass1 = roundtripMarkdown(src).trim();
    const pass2 = roundtripMarkdown(pass1).trim();
    expect(pass2).toBe(pass1);
    expect(pass1).toContain('$S = \\pi r^2$');
  });

  it('R14: 閉じ $$ の無いブロックは原文を失わず2回目以降冪等', () => {
    const src = '$$\nx';
    const pass1 = roundtripMarkdown(src).trim();
    const pass2 = roundtripMarkdown(pass1).trim();
    expect(pass2).toBe(pass1);
    expect(pass2).toBe('$$\nx\n$$');
  });

  it('R16 (M1): 行末の閉じ $$ (x $$) を認識し後続段落を飲み込まない', () => {
    const src = '$$\nx $$\n\n後続段落';
    const pass1 = roundtripMarkdown(src).trim();
    expect(pass1).toBe('$$\nx\n$$\n\n後続段落');
    const pass2 = roundtripMarkdown(pass1).trim();
    expect(pass2).toBe(pass1);
  });

  it('R17 (M1): 複数行で行末の閉じ $$ (\\end{aligned} $$) を認識し後続段落を飲み込まない', () => {
    const src = '$$\n\\begin{aligned}\na &= b\n\\end{aligned} $$\n\n後続段落';
    const pass1 = roundtripMarkdown(src).trim();
    expect(pass1).toBe('$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$\n\n後続段落');
    const pass2 = roundtripMarkdown(pass1).trim();
    expect(pass2).toBe(pass1);
  });

  it('R18: リスト内のブロック数式の閉じ行で相対インデントが保全される', () => {
    const src = '- 項目\n  $$\n    y $$';
    const pass1 = roundtripMarkdown(src).trim();
    expect(pass1).toContain('    y');
    const pass2 = roundtripMarkdown(pass1).trim();
    expect(pass2).toBe(pass1);
  });

  it('R15: math.md fixture の往復冪等性', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.resolve(__dirname, 'fixtures/math.md'), 'utf-8');
    const pass1 = roundtripMarkdown(src);
    const pass2 = roundtripMarkdown(pass1);
    expect(pass2).toBe(pass1);
  });
});
