import { Editor } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorExtensions } from '../markdown';
import { getTableMenuItems } from '../table-menu';
import { findTableAt } from '../table-utils';

// issue #222: 表のコンテキストメニュー(行/列の追加・削除、表の削除)

let editor: Editor;

afterEach(() => {
  editor.destroy();
});

const TABLE_MD = '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n';

function newTableEditor(): void {
  editor = new Editor({
    extensions: createEditorExtensions({ nodeViews: false }),
    content: TABLE_MD,
  });
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

// 指定テキストを含むセル(tableCell/tableHeader)ノードの直前位置を返す(CellSelection用)
function cellPosAround(text: string): number {
  const $pos = editor.state.doc.resolve(posBeforeText(text));
  for (let d = $pos.depth; d > 0; d--) {
    const name = $pos.node(d).type.name;
    if (name === 'tableCell' || name === 'tableHeader') return $pos.before(d);
  }
  throw new Error(`cell not found around: ${text}`);
}

describe('findTableAt / getTableMenuItems', () => {
  it('bodyセル選択時: 全11項目が出る', () => {
    newTableEditor();
    editor.commands.setTextSelection(posBeforeText('1'));
    expect(findTableAt(editor.state.selection.$from)).not.toBeNull();
    expect(itemLabels()).toEqual([
      '上に行を追加',
      '下に行を追加',
      '行を削除',
      '左に列を追加',
      '右に列を追加',
      '列を削除',
      '表をコピー',
      '表をカット',
      '表を上へ移動',
      '表を下へ移動',
      '表を削除',
    ]);
    expect(getTableMenuItems(editor).find((i) => i.label === '表を削除')?.danger).toBe(true);
  });

  it('ヘッダセル選択時: 「上に行を追加」「行を削除」が出ない(9項目)', () => {
    newTableEditor();
    editor.commands.setTextSelection(posBeforeText('A'));
    expect(itemLabels()).toEqual([
      '下に行を追加',
      '左に列を追加',
      '右に列を追加',
      '列を削除',
      '表をコピー',
      '表をカット',
      '表を上へ移動',
      '表を下へ移動',
      '表を削除',
    ]);
  });

  it('ヘッダ+bodyまたぎのCellSelectionでも「上に行を追加」「行を削除」が出ない', () => {
    // isActive('tableHeader')は非空選択でfalseになるため、選択範囲ベースの判定であることを保証する
    newTableEditor();
    editor.commands.command(({ tr, dispatch }) => {
      if (dispatch) {
        tr.setSelection(CellSelection.create(tr.doc, cellPosAround('A'), cellPosAround('1')));
      }
      return true;
    });
    expect(itemLabels()).toEqual([
      '下に行を追加',
      '左に列を追加',
      '右に列を追加',
      '列を削除',
      '表をコピー',
      '表をカット',
      '表を上へ移動',
      '表を下へ移動',
      '表を削除',
    ]);
  });

  it('1列だけの表では「列を削除」が出ない(prosemirror-tablesが拒否して無反応になるため)', () => {
    editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: '| A |\n| --- |\n| 1 |\n',
    });
    editor.commands.setTextSelection(posBeforeText('1'));
    expect(itemLabels()).not.toContain('列を削除');
  });

  it('表外(段落)では findTableAt が null になる', () => {
    editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: '本文',
    });
    editor.commands.setTextSelection(1);
    expect(findTableAt(editor.state.selection.$from)).toBeNull();
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

  it('ヘッダセルで「下に行を追加」(ヘッダ直下にbody行が入る)', () => {
    newTableEditor();
    editor.commands.setTextSelection(posBeforeText('A'));
    getTableMenuItems(editor)
      .find((i) => i.label === '下に行を追加')!
      .onSelect();
    expectGfmTable(getMarkdown());
  });

  it('ヘッダ行のみの表でも「下に行を追加」でGFMを維持する', () => {
    editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: '| A | B |\n| --- | --- |\n',
    });
    editor.commands.setTextSelection(posBeforeText('A'));
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

  it('表をコピーでクリップボードへ書き込みトースト通知する', async () => {
    newTableEditor();
    editor.commands.setTextSelection(posBeforeText('1'));
    const writeText = vi.fn().mockResolvedValue(undefined);
    // jsdomにclipboardは無いため、テスト用に定義する(table-block-ops.test.tsと同じ方式)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const showToast = vi.fn();
    try {
      getTableMenuItems(editor, { showToast })
        .find((i) => i.label === '表をコピー')!
        .onSelect();
      await vi.waitFor(() =>
        expect(showToast).toHaveBeenCalledWith('success', '表をコピーしました'),
      );
      expect(writeText.mock.calls[0][0]).toContain('| --- |');
    } finally {
      // @ts-expect-error テスト用に定義したプロパティを剥がす
      delete navigator.clipboard;
    }
  });

  it('表を上へ移動で直前の段落と入れ替わる', () => {
    editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: `前の段落\n\n${TABLE_MD}`,
    });
    editor.commands.setTextSelection(posBeforeText('1'));
    getTableMenuItems(editor)
      .find((i) => i.label === '表を上へ移動')!
      .onSelect();
    const md = getMarkdown();
    expect(md.indexOf('| --- |')).toBeLessThan(md.indexOf('前の段落'));
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
