import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorExtensions } from '../markdown';
import { pressKey } from './helpers';

// jsdom には ClipboardEvent が無く、view.pasteText/pasteHTML が new ClipboardEvent() で落ちる。
// tiptap の pasteRulesPlugin は new Editor() 時点で typeof ClipboardEvent を評価するため、
// エディタ生成より前(モジュールトップ)で定義すること。vite.config.ts に setupFiles は無い
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

// 実入力経路(handleTextInput → InputRule)で1文字ずつ入力する。
// insertContent は InputRule を通らないため使わない
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
// 段落の子ノード型の並び(例: ['wikilink'] / ['text','obsidianEmbed'])
const inlineTypes = (editor: Editor) =>
  (editor.getJSON().content?.[0]?.content ?? []).map((n) => n.type);

describe('wikilink / 埋め込みの手入力・貼り付け', () => {
  afterEach(() => {
    activeEditor?.destroy();
    activeEditor = null;
    document.body.innerHTML = '';
  });

  describe('A. 手入力(InputRule)', () => {
    it('A1: [[foo]] を手入力すると wikilink ノードに変換される', () => {
      const editor = createEditor();
      typeText(editor, '[[foo]]');
      expect(markdownOf(editor)).toBe('[[foo]]');
      expect(inlineTypes(editor)).toEqual(['wikilink']);
      const node = editor.getJSON().content?.[0]?.content?.[0];
      expect(node?.attrs).toEqual({ target: 'foo', alias: null });
    });

    it('A2: [[foo|bar]] を手入力すると alias 付き wikilink ノードに変換される', () => {
      const editor = createEditor();
      typeText(editor, '[[foo|bar]]');
      expect(markdownOf(editor)).toBe('[[foo|bar]]');
      expect(inlineTypes(editor)).toEqual(['wikilink']);
      const node = editor.getJSON().content?.[0]?.content?.[0];
      expect(node?.attrs).toEqual({ target: 'foo', alias: 'bar' });
    });

    it('A3: [[存在しないページ]] を手入力すると wikilink ノードに変換される', () => {
      const editor = createEditor();
      typeText(editor, '[[存在しないページ]]');
      expect(markdownOf(editor)).toBe('[[存在しないページ]]');
      expect(inlineTypes(editor)).toEqual(['wikilink']);
      const node = editor.getJSON().content?.[0]?.content?.[0];
      expect(node?.attrs).toEqual({ target: '存在しないページ', alias: null });
    });

    it('A4: a ![[img.png]] を手入力すると text と obsidianEmbed ノードになり wikilink を含まない', () => {
      const editor = createEditor();
      typeText(editor, 'a ![[img.png]]');
      expect(markdownOf(editor)).toBe('a ![[img.png]]');
      expect(inlineTypes(editor)).toEqual(['text', 'obsidianEmbed']);
      const embed = editor.getJSON().content?.[0]?.content?.[1];
      expect(embed?.attrs).toEqual({ target: 'img.png' });
    });

    it('A5: ![[a.png|300]] を手入力すると obsidianEmbed ノードになり target にパイプ以降も保持する', () => {
      const editor = createEditor();
      typeText(editor, '![[a.png|300]]');
      expect(markdownOf(editor)).toBe('![[a.png|300]]');
      expect(inlineTypes(editor)).toEqual(['obsidianEmbed']);
      const embed = editor.getJSON().content?.[0]?.content?.[0];
      expect(embed?.attrs).toEqual({ target: 'a.png|300' });
    });

    it('A6: ［［foo］］ (全角)を手入力すると半角の wikilink ノードに正規化される', () => {
      const editor = createEditor();
      typeText(editor, '［［foo］］');
      expect(markdownOf(editor)).toBe('[[foo]]');
      expect(inlineTypes(editor)).toEqual(['wikilink']);
      const node = editor.getJSON().content?.[0]?.content?.[0];
      expect(node?.attrs).toEqual({ target: 'foo', alias: null });
    });

    it('A7: ［［foo｜別名］］ (全角)を手入力すると半角の alias 付き wikilink ノードに正規化される', () => {
      const editor = createEditor();
      typeText(editor, '［［foo｜別名］］');
      expect(markdownOf(editor)).toBe('[[foo|別名]]');
      expect(inlineTypes(editor)).toEqual(['wikilink']);
      const node = editor.getJSON().content?.[0]?.content?.[0];
      expect(node?.attrs).toEqual({ target: 'foo', alias: '別名' });
    });

    it('A8: ！［［i.png］］ (全角)を手入力すると半角の obsidianEmbed ノードに正規化される', () => {
      const editor = createEditor();
      typeText(editor, '！［［i.png］］');
      expect(markdownOf(editor)).toBe('![[i.png]]');
      expect(inlineTypes(editor)).toEqual(['obsidianEmbed']);
      const embed = editor.getJSON().content?.[0]?.content?.[0];
      expect(embed?.attrs).toEqual({ target: 'i.png' });
    });

    it('A9: [[a]] [[b]] を手入力すると2つの wikilink ノードになる', () => {
      const editor = createEditor();
      typeText(editor, '[[a]] [[b]]');
      expect(markdownOf(editor)).toBe('[[a]] [[b]]');
      expect(inlineTypes(editor)).toEqual(['wikilink', 'text', 'wikilink']);
    });

    it('A10: [[a]][[b]] を手入力すると間にスペースがなくても2つの wikilink ノードになる', () => {
      const editor = createEditor();
      typeText(editor, '[[a]][[b]]');
      expect(markdownOf(editor)).toBe('[[a]][[b]]');
      expect(inlineTypes(editor)).toEqual(['wikilink', 'wikilink']);
    });

    it('A11: インラインコード内に入力しても wikilink に変換されない', () => {
      const editor = createEditor('`x`');
      // `x` の x の直後(pos 2)にカーソルを移動
      editor.commands.setTextSelection(2);
      typeText(editor, '[[foo]]');
      expect(inlineTypes(editor)).toEqual(['text']);
      expect(editor.getJSON().content?.[0]?.content?.[0]?.marks?.[0]?.type).toBe('code');
      expect(markdownOf(editor)).toBe('`x[[foo]]`');
    });

    it('A12: [[foo]] 入力直後に Backspace を押すとリテラルに戻り、エスケープして保存される', () => {
      const editor = createEditor();
      typeText(editor, '[[foo]]');
      // undoInputRule が走る
      pressKey(editor, 'Backspace');
      expect(inlineTypes(editor)).toEqual(['text']);
      // undoInputRule でリテラルに戻した場合のエスケープは正しい挙動としてコメント付きで固定
      expect(markdownOf(editor)).toBe('\\[\\[foo\\]\\]');
    });
  });

  describe('B. IME 確定(compositionend)', () => {
    it('B1: IME 確定で [[日本語]] が入力された場合に wikilink ノードになる', async () => {
      const editor = createEditor();
      editor.view.dispatch(editor.state.tr.insertText('[[日本語]]', 1));
      editor.view.dom.dispatchEvent(new Event('compositionend'));
      await new Promise((r) => setTimeout(r, 0));
      expect(markdownOf(editor)).toBe('[[日本語]]');
      expect(inlineTypes(editor)).toEqual(['wikilink']);
    });

    it('B2: IME 確定で ![[画像.png]] が入力された場合に obsidianEmbed ノードになる', async () => {
      const editor = createEditor();
      editor.view.dispatch(editor.state.tr.insertText('![[画像.png]]', 1));
      editor.view.dom.dispatchEvent(new Event('compositionend'));
      await new Promise((r) => setTimeout(r, 0));
      expect(markdownOf(editor)).toBe('![[画像.png]]');
      expect(inlineTypes(editor)).toEqual(['obsidianEmbed']);
    });
  });

  describe('C. 貼り付け(PasteRule)', () => {
    it('C1: [[存在しないページ]] を pasteText すると wikilink ノードになりエスケープされない', () => {
      const editor = createEditor();
      editor.view.pasteText('[[存在しないページ]]');
      expect(markdownOf(editor)).toBe('[[存在しないページ]]');
      expect(inlineTypes(editor)).toEqual(['wikilink']);
    });

    it('C2: x ![[img.png]] y [[a]] [[b|c]] z を pasteText すると混在してノード化される', () => {
      const editor = createEditor();
      editor.view.pasteText('x ![[img.png]] y [[a]] [[b|c]] z');
      expect(markdownOf(editor)).toBe('x ![[img.png]] y [[a]] [[b|c]] z');
      expect(inlineTypes(editor)).toEqual([
        'text',
        'obsidianEmbed',
        'text',
        'wikilink',
        'text',
        'wikilink',
        'text',
      ]);
    });

    it('C3: 複数段落の貼り付けで wikilink と埋め込みがそれぞれ変換される', () => {
      const editor = createEditor();
      editor.view.pasteText('line1 [[a]]\n\nline2 ![[b.png|200]]');
      expect(markdownOf(editor)).toBe('line1 [[a]]\n\nline2 ![[b.png|200]]');
    });

    it('C4: pasteHTML <p>see [[h]] and ![[i.png]]</p> でも変換される', () => {
      const editor = createEditor();
      editor.view.pasteHTML('<p>see [[h]] and ![[i.png]]</p>');
      expect(markdownOf(editor)).toBe('see [[h]] and ![[i.png]]');
      expect(inlineTypes(editor)).toEqual(['text', 'wikilink', 'text', 'obsidianEmbed']);
    });

    it('C5: コードブロック内に pasteText しても wikilink に変換されない', () => {
      const editor = createEditor('```\n\n```');
      // コードブロック内にカーソル移動 (pos 2)
      editor.commands.setTextSelection(2);
      editor.view.pasteText('[[incode]]');
      expect(markdownOf(editor)).toBe('```\n[[incode]]\n```');
    });

    it('C6: インラインコード内に pasteText しても wikilink に変換されない', () => {
      const editor = createEditor('a `xy` b');
      // `xy` の x と y の間 (pos 4) にカーソル移動
      editor.commands.setTextSelection(4);
      editor.view.pasteText('[[c]]');
      expect(markdownOf(editor)).toBe('a `x[[c]]y` b');
      expect(inlineTypes(editor)).not.toContain('wikilink');
    });

    it('C7: インラインコード外での貼り付けは通常通り wikilink に変換される', () => {
      const editor = createEditor('a b');
      editor.commands.setTextSelection(3);
      editor.view.pasteText('[[d]]');
      expect(markdownOf(editor)).toBe('a [[d]]b');
      expect(inlineTypes(editor)).toContain('wikilink');
    });

    it('C8: pasteText ［［全角］］ は全角のまま保持され変換されない', () => {
      const editor = createEditor();
      editor.view.pasteText('［［全角］］');
      expect(markdownOf(editor)).toBe('［［全角］］');
      expect(inlineTypes(editor)).toEqual(['text']);
    });

    it('C9: 既存テキストの前後に pasteText しても正しく結合される', () => {
      const editor = createEditor('前後');
      editor.commands.setTextSelection(2);
      editor.view.pasteText('[[a]]');
      expect(markdownOf(editor)).toBe('前[[a]]後');
      expect(inlineTypes(editor)).toEqual(['text', 'wikilink', 'text']);
    });
  });

  describe('D. コピー(renderText)', () => {
    it('D1: getText() で wikilink と埋め込み記法が復元される', () => {
      const editor = createEditor('a [[x|y]] ![[i.png]] b');
      expect(editor.getText()).toBe('a [[x|y]] ![[i.png]] b');
    });

    it('D2: clipboardTextSerializer 経由でテキストが記法通り復元される', () => {
      const editor = createEditor('a [[x|y]] ![[i.png]] b');
      const slice = editor.state.doc.slice(0, editor.state.doc.content.size);
      const text = editor.view.someProp('clipboardTextSerializer', (f) => f(slice, editor.view));
      if (typeof text === 'string') {
        expect(text).toContain('[[x|y]]');
        expect(text).toContain('![[i.png]]');
      } else {
        expect(editor.getText()).toBe('a [[x|y]] ![[i.png]] b');
      }
    });
  });
});
