import type { Editor } from '@tiptap/core';
import type { ContextMenuItem } from '../components/ContextMenu';
import { findTableAt } from './table-utils';

// issue #222: 表のコンテキストメニュー(行/列の追加・削除、表の削除)
// ロジックをDocViewから切り出した純粋関数。カーソル位置に応じた項目の出し分けはここに集約する。

export function getTableMenuItems(editor: Editor): ContextMenuItem[] {
  const table = findTableAt(editor.state.selection.$from);
  // tiptap-markdownはヘッダ行のない表をHTML表としてシリアライズしてしまうため、
  // ヘッダ行を消せる/ヘッダの上に行を作れる操作(行追加・行削除)はヘッダ行に掛かる選択では出さない。
  // isActive('tableHeader')は非空選択(CellSelectionのヘッダ+bodyまたぎ等)でfalseになり、
  // CellSelectionのfrom/toも全セルを覆わないため、選択の全range(セルごと)を見て判定する
  let inHeader = false;
  for (const range of editor.state.selection.ranges) {
    editor.state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node) => {
      if (node.type.name === 'tableHeader') inHeader = true;
    });
  }

  const items: ContextMenuItem[] = [];
  if (!inHeader) {
    items.push({
      label: '上に行を追加',
      onSelect: () => editor.chain().focus().addRowBefore().run(),
    });
  }
  items.push({
    label: '下に行を追加',
    onSelect: () => editor.chain().focus().addRowAfter().run(),
  });
  if (!inHeader) {
    items.push({
      label: '行を削除',
      onSelect: () => editor.chain().focus().deleteRow().run(),
    });
  }
  items.push(
    {
      label: '左に列を追加',
      onSelect: () => editor.chain().focus().addColumnBefore().run(),
    },
    {
      label: '右に列を追加',
      onSelect: () => editor.chain().focus().addColumnAfter().run(),
    },
  );
  // 1列だけの表はprosemirror-tablesがdeleteColumnを拒否して無反応になるため項目を出さない
  // (GFM表にcolspanは無いので1行目のセル数=列数)
  if ((table?.node.firstChild?.childCount ?? 0) > 1) {
    items.push({
      label: '列を削除',
      onSelect: () => editor.chain().focus().deleteColumn().run(),
    });
  }
  items.push({
    label: '表を削除',
    onSelect: () => editor.chain().focus().deleteTable().run(),
    danger: true,
  });
  return items;
}
