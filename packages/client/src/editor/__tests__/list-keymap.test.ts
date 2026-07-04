import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorExtensions } from '../markdown';

// issue #6 macOS検証での指摘:
// 空のリスト項目でBackspaceしたあとEnterしても空行が増えない違和感の修正確認。
// keyboardShortcutでEnter/Backspaceのキーマップ処理チェーンを直接発火して検証する。

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
