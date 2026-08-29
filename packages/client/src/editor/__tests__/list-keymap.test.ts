import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorExtensions } from '../markdown';
import { pressKey as pressKeyOn } from './helpers';

// issue #6 macOS検証での指摘:
// 空のリスト項目でBackspaceしたあとEnterしても空行が増えない違和感の修正確認。
// issue #220: リスト解除後の空段落でのBSでビュレットが復活し無限往復する問題の修正確認。

let editor: Editor;

afterEach(() => {
  editor.destroy();
});

function topLevelTypes(): string[] {
  const types: string[] = [];
  editor.state.doc.forEach((node) => {
    types.push(node.type.name);
  });
  return types;
}

// カーソル位置を検証するテストは実キー経路で発火する(helpers.ts参照)
function pressKey(key: string, init: KeyboardEventInit = {}) {
  pressKeyOn(editor, key, init);
}

describe('空リスト項目のBackspace(ListKeymap)', () => {
  it('箇条書き: BSでリスト外の空段落になり、次のEnterで行が増える', () => {
    editor = new Editor({ extensions: createEditorExtensions(), content: '- 項目' });
    editor.commands.focus('end');
    editor.commands.keyboardShortcut('Enter'); // 空アイテム作成

    editor.commands.keyboardShortcut('Backspace');
    // 空アイテムがリスト外の段落に変換される(前の項目への合体ではない)
    expect(topLevelTypes()).toEqual(['bulletList', 'paragraph']);

    editor.commands.keyboardShortcut('Enter');
    // 空行が素直に増える
    expect(topLevelTypes()).toEqual(['bulletList', 'paragraph', 'paragraph']);
  });

  it('チェックリスト: BSでリスト外の空段落になる', () => {
    editor = new Editor({ extensions: createEditorExtensions(), content: '- [ ] タスク' });
    editor.commands.focus('end');
    editor.commands.keyboardShortcut('Enter');

    editor.commands.keyboardShortcut('Backspace');
    expect(topLevelTypes()).toEqual(['taskList', 'paragraph']);
  });

  it('文字が残っている項目の行頭BSは既定動作のまま(前の項目と結合)', () => {
    editor = new Editor({ extensions: createEditorExtensions(), content: '- あ\n- い' });
    // 2項目目の段落先頭(テキスト「い」の直前)にカーソルを置く
    let target = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'い') target = pos;
      return true;
    });
    expect(target).toBeGreaterThan(0);
    editor.commands.setTextSelection(target);
    editor.commands.keyboardShortcut('Backspace');
    // カスタムハンドラは介入せず、既定動作(前の項目への構造結合)のまま。
    // リストは維持され、リスト外への変換は起きない
    expect(topLevelTypes()).toEqual(['bulletList']);
    expect(editor.getText()).toContain('あ');
    expect(editor.getText()).toContain('い');
  });
});

describe('リスト直後の空段落のBackspace(issue #220)', () => {
  it('リスト解除後の空段落でさらにBSすると、空段落が消えて前項目の行末に戻る(ビュレット復活しない)', () => {
    editor = new Editor({ extensions: createEditorExtensions(), content: '- 項目' });
    editor.commands.focus('end');
    pressKey('Enter'); // 空アイテム作成
    pressKey('Backspace'); // リスト解除 → [bulletList, paragraph]
    expect(topLevelTypes()).toEqual(['bulletList', 'paragraph']);

    pressKey('Backspace');
    // 既定動作だと空段落がlistItemとしてリストに再取り込みされてしまう。
    // Obsidian同様、空段落は削除されて前項目の行末にカーソルが戻る
    expect(topLevelTypes()).toEqual(['bulletList']);
    const list = editor.state.doc.firstChild!;
    expect(list.childCount).toBe(1); // 空のlistItemが増えていない

    // カーソルは「項目」の行末
    const { $from } = editor.state.selection;
    expect($from.parent.textContent).toBe('項目');
    expect($from.parentOffset).toBe($from.parent.content.size);

    // 文字入力すると前項目の続きに入る
    editor.commands.insertContent('続き');
    expect(editor.getText()).toContain('項目続き');
  });

  it('リストの後ろに別の段落がある構成でも前項目の行末に着地する', () => {
    editor = new Editor({ extensions: createEditorExtensions(), content: '- 項目\n\n後続' });
    // リスト末尾でEnter→BSして、リストと「後続」の間に空段落を作る
    let itemEnd = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === '項目') itemEnd = pos + node.nodeSize;
      return true;
    });
    editor.commands.setTextSelection(itemEnd);
    pressKey('Enter');
    pressKey('Backspace');
    expect(topLevelTypes()).toEqual(['bulletList', 'paragraph', 'paragraph']);

    pressKey('Backspace');
    expect(topLevelTypes()).toEqual(['bulletList', 'paragraph']);
    // 後続段落の先頭ではなく、前項目「項目」の行末にいること
    const { $from } = editor.state.selection;
    expect($from.parent.textContent).toBe('項目');
    expect($from.parentOffset).toBe($from.parent.content.size);
  });

  it('番号付きリスト直後の空段落BSも同様に前項目の行末へ戻る', () => {
    editor = new Editor({ extensions: createEditorExtensions(), content: '1. 項目' });
    editor.commands.focus('end');
    pressKey('Enter');
    pressKey('Backspace');
    expect(topLevelTypes()).toEqual(['orderedList', 'paragraph']);

    pressKey('Backspace');
    expect(topLevelTypes()).toEqual(['orderedList']);
    expect(editor.state.doc.firstChild!.childCount).toBe(1);
    expect(editor.state.selection.$from.parent.textContent).toBe('項目');
  });

  it('チェックリスト直後の空段落BSも同様に前項目の行末へ戻る', () => {
    editor = new Editor({ extensions: createEditorExtensions(), content: '- [ ] タスク' });
    editor.commands.focus('end');
    pressKey('Enter');
    pressKey('Backspace');
    expect(topLevelTypes()).toEqual(['taskList', 'paragraph']);

    pressKey('Backspace');
    expect(topLevelTypes()).toEqual(['taskList']);
    expect(editor.state.doc.firstChild!.childCount).toBe(1);
    expect(editor.state.selection.$from.parent.textContent).toBe('タスク');
  });

  it('blockquote内のリストでもビュレット復活のループにならない', () => {
    editor = new Editor({ extensions: createEditorExtensions(), content: '> - 項目' });
    editor.commands.focus('end');
    pressKey('Enter'); // 空アイテム作成
    pressKey('Backspace'); // リスト解除 → blockquote > [bulletList, paragraph]

    pressKey('Backspace');
    // ビュレットが復活せず、空段落が消えて前項目の行末に戻る
    const blockquote = editor.state.doc.firstChild!;
    expect(blockquote.type.name).toBe('blockquote');
    expect(blockquote.childCount).toBe(1);
    expect(blockquote.firstChild!.type.name).toBe('bulletList');
    expect(blockquote.firstChild!.childCount).toBe(1);
    expect(editor.state.selection.$from.parent.textContent).toBe('項目');
  });

  it.each([
    ['Mod-Backspace', { ctrlKey: true }],
    ['Shift-Backspace', { shiftKey: true }],
  ] as [string, KeyboardEventInit][])('%sでもビュレットが復活しない', (_name, init) => {
    editor = new Editor({ extensions: createEditorExtensions(), content: '- 項目' });
    editor.commands.focus('end');
    pressKey('Enter');
    pressKey('Backspace');
    expect(topLevelTypes()).toEqual(['bulletList', 'paragraph']);

    pressKey('Backspace', init);
    expect(topLevelTypes()).toEqual(['bulletList']);
    expect(editor.state.doc.firstChild!.childCount).toBe(1);
  });

  it('段落直後の空段落BSは既定動作のまま(カスタム介入しない)', () => {
    editor = new Editor({ extensions: createEditorExtensions(), content: 'テキスト' });
    editor.commands.focus('end');
    pressKey('Enter'); // 空段落を追加
    expect(topLevelTypes()).toEqual(['paragraph', 'paragraph']);

    pressKey('Backspace');
    // 既定のjoinBackwardで空段落が消える(挙動が壊れていないこと)
    expect(topLevelTypes()).toEqual(['paragraph']);
    expect(editor.getText()).toBe('テキスト');
  });
});
