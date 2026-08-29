import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorExtensions } from '../markdown';
import { getTableMenuItems, isInTable } from '../table-menu';

// issue #222: 表のコンテキストメニュー(行/列の追加・削除、表の削除)

let editor: Editor;

afterEach(() => {
  editor.destroy();
});

const TABLE_MD = '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n';

function newTableEditor(): void {
  editor = new Editor({ extensions: createEditorExtensions({ nodeViews: false }), content: TABLE_MD });
}

function getMarkdown(): string {
  return editor.storage.markdown.getMarkdown() as string;
}

// テキストノードの直前位置にカーソルを置く(list-keymap.test.tsと同じ探索方式)
function posBeforeText(text: string): number {
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (target !== -1) return false;
    if (node.isText && node.text === text) {
      target = pos;
      return false;
    }
    return true;
  });
  if (target === -1) throw new Error(`text not found: ${text}`);
  return target;
}

function itemLabels(): string[] {
  return getTableMenuItems(editor).map((item) => item.label);
}

function expectGfmTable(md: string) {
  expect(md).toContain('| --- |');
  expect(md).not.toContain('<table');
}

describe('isInTable / getTableMenuItems', () => {
  it('bodyセル選択時: 7項目すべて出る', () => {
    newTableEditor();
    editor.commands.setTextSelection(posBeforeText('1'));
    expect(isInTable(editor)).toBe(true);
    expect(itemLabels()).toEqual([
      '上に行を追加',
      '下に行を追加',
      '行を削除',
      '左に列を追加',
      '右に列を追加',
      '列を削除',
      '表を削除',
    ]);
    expect(getTableMenuItems(editor).find((i) => i.label === '表を削除')?.danger).toBe(true);
  });

  it('ヘッダセル選択時: 「上に行を追加」「行を削除」が出ない(5項目)', () => {
    newTableEditor();
    editor.commands.setTextSelection(posBeforeText('A'));
    expect(isInTable(editor)).toBe(true);
    expect(itemLabels()).toEqual(['下に行を追加', '左に列を追加', '右に列を追加', '列を削除', '表を削除']);
  });

  it('表外(段落)では isInTable が false になる', () => {
    editor = new Editor({ extensions: createEditorExtensions({ nodeViews: false }), content: '本文' });
    editor.commands.setTextSelection(1);
    expect(isInTable(editor)).toBe(false);
    // getTableMenuItemsは表内であることを呼び出し側(DocView)が保証した上で使う前提のため、
    // 表外での戻り値は仕様の対象外
  });
});

describe('表操作後もGFMパイプ表を維持する', () => {
  it('上に行を追加', () => {
    newTableEditor();
    editor.commands.setTextSelection(posBeforeText('1'));
    getTableMenuItems(editor)
      .find((i) => i.label === '上に行を追加')!
      .onSelect();
    expectGfmTable(getMarkdown());
  });

  it('下に行を追加', () => {
    newTableEditor();
    editor.commands.setTextSelection(posBeforeText('1'));
    getTableMenuItems(editor)
      .find((i) => i.label === '下に行を追加')!
      .onSelect();
    expectGfmTable(getMarkdown());
  });

  it('行を削除', () => {
    newTableEditor();
    editor.commands.setTextSelection(posBeforeText('1'));
    getTableMenuItems(editor)
      .find((i) => i.label === '行を削除')!
      .onSelect();
    const md = getMarkdown();
    expectGfmTable(md);
    expect(md).not.toContain('1');
  });

  it('左に列を追加', () => {
    newTableEditor();
    editor.commands.setTextSelection(posBeforeText('1'));
    getTableMenuItems(editor)
      .find((i) => i.label === '左に列を追加')!
      .onSelect();
    expectGfmTable(getMarkdown());
  });

  it('右に列を追加', () => {
    newTableEditor();
    editor.commands.setTextSelection(posBeforeText('1'));
    getTableMenuItems(editor)
      .find((i) => i.label === '右に列を追加')!
      .onSelect();
    expectGfmTable(getMarkdown());
  });

  it('列を削除', () => {
    newTableEditor();
    editor.commands.setTextSelection(posBeforeText('1'));
    getTableMenuItems(editor)
      .find((i) => i.label === '列を削除')!
      .onSelect();
    const md = getMarkdown();
    expectGfmTable(md);
    // カーソルは1列目(A列)のセルにあるため、削除されるのはA列
    expect(md).not.toContain('A');
  });

  it('表を削除で表が消える', () => {
    newTableEditor();
    editor.commands.setTextSelection(posBeforeText('1'));
    getTableMenuItems(editor)
      .find((i) => i.label === '表を削除')!
      .onSelect();
    let hasTable = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'table') hasTable = true;
    });
    expect(hasTable).toBe(false);
    expect(getMarkdown()).not.toContain('| --- |');
  });
});
