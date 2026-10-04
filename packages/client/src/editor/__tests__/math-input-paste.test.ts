import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorExtensions } from '../markdown';

// jsdom 環境での ClipboardEvent polyfill
class ClipboardEventPolyfill extends Event {
  clipboardData: DataTransfer | null = null;
}
if (typeof globalThis.ClipboardEvent === 'undefined') {
  (globalThis as unknown as { ClipboardEvent: unknown }).ClipboardEvent = ClipboardEventPolyfill;
}

let activeEditor: Editor | null = null;

function createEditor(content = '') {
  const element = document.createElement('div');
  document.body.appendChild(element);
  activeEditor = new Editor({
    element,
    extensions: createEditorExtensions({ nodeViews: false }),
    content,
  });
  return activeEditor;
}

// 実入力経路(handleTextInput → InputRule)で1文字ずつ入力
function typeText(editor: Editor, text: string) {
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp('handleTextInput', (f) =>
      f(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to)),
    );
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
  }
}

const markdownOf = (editor: Editor) => (editor.storage.markdown.getMarkdown() as string).trim();
const inlineTypes = (editor: Editor) =>
  (editor.getJSON().content?.[0]?.content ?? []).map((n) => n.type);

describe('数式の手入力・貼り付け (InputRule / PasteRule)', () => {
  afterEach(() => {
    activeEditor?.destroy();
    activeEditor = null;
    document.body.innerHTML = '';
  });

  describe('I. 手入力 (InputRule)', () => {
    it('I1: $x^2$ と入力すると mathInline(latex="x^2") に変換される', () => {
      const editor = createEditor();
      typeText(editor, '$x^2$');
      expect(markdownOf(editor)).toBe('$x^2$');
      expect(inlineTypes(editor)).toEqual(['mathInline']);
      const node = editor.getJSON().content?.[0]?.content?.[0];
      expect(node?.attrs).toEqual({ latex: 'x^2' });
    });

    it('I2: $5 と $ と入力しても変換されない', () => {
      const editor = createEditor();
      typeText(editor, '$5 と $');
      expect(markdownOf(editor)).toBe('$5 と $');
      expect(inlineTypes(editor)).toEqual(['text']);
    });

    it('I3: \\$x$ と入力しても変換されない', () => {
      const editor = createEditor();
      typeText(editor, '\\$x$');
      expect(inlineTypes(editor)).toEqual(['text']);
    });

    it('I4: インラインコード内で $x$ と入力しても変換されない', () => {
      const editor = createEditor('`code`');
      // `code` の c の直後(pos 2)にカーソル移動
      editor.commands.setTextSelection(2);
      typeText(editor, '$x$');
      expect(inlineTypes(editor)).toEqual(['text']);
      expect(markdownOf(editor)).toBe('`c$x$ode`');
    });

    it('I5: コードブロック内で $x$ / $$ と入力しても変換されない', () => {
      const editor = createEditor('```\n\n```');
      editor.commands.setTextSelection(2);
      typeText(editor, '$x$');
      typeText(editor, '$$ ');
      const block = editor.getJSON().content?.[0];
      expect(block?.type).toBe('codeBlock');
      expect(block?.content?.[0]?.text).toContain('$x$');
    });

    it('I6: 空段落で $$ + Space で mathBlock に変換される', () => {
      const editor = createEditor();
      typeText(editor, '$$ ');
      const block = editor.getJSON().content?.[0];
      expect(block?.type).toBe('mathBlock');
    });

    it('I7: mathBlock 内で $x$ と入力しても変換されない (テキストのまま)', () => {
      const editor = createEditor();
      typeText(editor, '$$ ');
      // mathBlock 内に入力
      typeText(editor, '$x$');
      const block = editor.getJSON().content?.[0];
      expect(block?.type).toBe('mathBlock');
      expect(block?.content?.[0]?.type).toBe('text');
      expect(block?.content?.[0]?.text).toBe('$x$');
    });
  });

  describe('P. 貼り付け (PasteRule)', () => {
    it('P1: 前 $x$ 後 を貼り付けると mathInline に変換される', () => {
      const editor = createEditor();
      editor.view.pasteText('前 $x$ 後');
      expect(markdownOf(editor)).toBe('前 $x$ 後');
      expect(inlineTypes(editor)).toEqual(['text', 'mathInline', 'text']);
      const mathNode = editor.getJSON().content?.[0]?.content?.[1];
      expect(mathNode?.attrs).toEqual({ latex: 'x' });
    });

    it('P2: インラインコード内へ $x$ を貼り付けても変換されない', () => {
      const editor = createEditor('`code`');
      editor.commands.setTextSelection(2);
      editor.view.pasteText('$x$');
      expect(markdownOf(editor)).toBe('`c$x$ode`');
      expect(inlineTypes(editor)).toEqual(['text']);
    });

    it('P3: $x$ と [[foo]] を貼り付けると数式と wikilink の両方が変換される', () => {
      const editor = createEditor();
      editor.view.pasteText('$x$ と [[foo]]');
      expect(markdownOf(editor)).toBe('$x$ と [[foo]]');
      expect(inlineTypes(editor)).toEqual(['mathInline', 'text', 'wikilink']);
    });

    it('P4: $5 と $10 を貼り付けても変換されない', () => {
      const editor = createEditor();
      editor.view.pasteText('$5 と $10');
      expect(markdownOf(editor)).toBe('$5 と $10');
      expect(inlineTypes(editor)).toEqual(['text']);
    });

    it('P5: 複数行の $$...$$ を貼り付けると mathBlock に変換される', () => {
      const editor = createEditor();
      editor.view.pasteText('$$\nx = 1\n$$');
      const json = editor.getJSON();
      expect(json.content?.[0]?.type).toBe('mathBlock');
      expect(json.content?.[0]?.content?.[0]?.text).toBe('x = 1');
      expect(markdownOf(editor)).toBe('$$\nx = 1\n$$');
    });

    it('P6: 複数行の複雑な LaTeX を貼り付けると改行が保持されて mathBlock になる', () => {
      const editor = createEditor();
      editor.view.pasteText('$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$');
      const json = editor.getJSON();
      expect(json.content?.[0]?.type).toBe('mathBlock');
      expect(json.content?.[0]?.content?.[0]?.text).toBe(
        '\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}',
      );
    });

    it('P7: 1行形式の $$x = 1$$ を貼り付けると mathBlock に変換される', () => {
      const editor = createEditor();
      editor.view.pasteText('$$x = 1$$');
      const json = editor.getJSON();
      expect(json.content?.[0]?.type).toBe('mathBlock');
      expect(json.content?.[0]?.content?.[0]?.text).toBe('x = 1');
    });

    it('P8: 文章と数式ブロックが混在したテキストを貼り付けると分解されて挿入される', () => {
      const editor = createEditor();
      editor.view.pasteText('説明文\n\n$$\nx = 1\n$$\n\nまとめ');
      const json = editor.getJSON();
      expect(json.content?.map((n) => n.type)).toEqual(['paragraph', 'mathBlock', 'paragraph']);
      expect(json.content?.[1]?.content?.[0]?.text).toBe('x = 1');
    });

    it('P9: コードブロック内やインラインコード内へ $$...$$ を貼り付けても mathBlock に変換されない', () => {
      const editor1 = createEditor('```\n\n```');
      editor1.commands.setTextSelection(2);
      editor1.view.pasteText('$$\nx = 1\n$$');
      expect(editor1.getJSON().content?.[0]?.type).toBe('codeBlock');
      expect(editor1.getJSON().content?.[0]?.content?.[0]?.text).toContain('$$');

      const editor2 = createEditor('`code`');
      editor2.commands.setTextSelection(2);
      editor2.view.pasteText('$$\nx = 1\n$$');
      expect(editor2.getJSON().content?.[0]?.type).toBe('paragraph');
      expect(editor2.getJSON().content?.[0]?.content?.[0]?.marks?.[0]?.type).toBe('code');
    });

    it('P10: $x$ 単体を貼り付けると mathInline に変換される', () => {
      const editor = createEditor();
      editor.view.pasteText('$x$');
      expect(inlineTypes(editor)).toEqual(['mathInline']);
      expect(editor.getJSON().content?.[0]?.content?.[0]?.attrs).toEqual({ latex: 'x' });
    });

    it('P11: $x \\$ y$ (エスケープされたドル記号を含む) を貼り付けると mathInline に変換される', () => {
      const editor = createEditor();
      editor.view.pasteText('$x \\$ y$');
      expect(inlineTypes(editor)).toEqual(['mathInline']);
      expect(editor.getJSON().content?.[0]?.content?.[0]?.attrs).toEqual({ latex: 'x \\$ y' });
    });

    it('P12: 末尾が \\$ の不正な $a\\$ を貼り付けても mathInline に変換されない', () => {
      const editor = createEditor();
      editor.view.pasteText('$a\\$');
      expect(inlineTypes(editor)).toEqual(['text']);
    });

    it('P13: 複数ブロック一括貼り付け ($$\\nx\\n$$\\n\\n$$\\ny\\n$$) が2つの mathBlock になる', () => {
      const editor = createEditor();
      editor.view.pasteText('$$\nx\n$$\n\n$$\ny\n$$');
      const json = editor.getJSON();
      const mathBlocks = (json.content ?? []).filter((n) => n.type === 'mathBlock');
      expect(mathBlocks).toHaveLength(2);
      expect(mathBlocks[0]?.content?.[0]?.text).toBe('x');
      expect(mathBlocks[1]?.content?.[0]?.text).toBe('y');
    });

    it('P14: 行内複数ペア ($$a$$ と $$b$$) を貼り付けても単一の巨大ブロックに誤結合されない', () => {
      const editor = createEditor();
      editor.view.pasteText('$$a$$ と $$b$$');
      const json = editor.getJSON();
      // 単一の巨大 mathBlock (a$$ と $$b) に結合されず、段落または分割ノードになること
      const firstNode = json.content?.[0];
      if (firstNode?.type === 'mathBlock') {
        expect(firstNode.content?.[0]?.text).not.toContain('$$');
      } else {
        expect(firstNode?.type).toBe('paragraph');
      }
    });
  });
});
