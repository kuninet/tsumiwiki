import type { Editor } from '@tiptap/core';
import type { ContextMenuItem } from '../components/ContextMenu';

// issue #222: 表のコンテキストメニュー(行/列の追加・削除、表の削除)
// ロジックをDocViewから切り出した純粋関数。カーソル位置に応じた項目の出し分けはここに集約する。

export function isInTable(editor: Editor): boolean {
  return editor.isActive('table');
}

export function getTableMenuItems(editor: Editor): ContextMenuItem[] {
  // tiptap-markdownはヘッダ行のない表をHTML表としてシリアライズしてしまうため、
  // ヘッダ行を消せる/ヘッダの上に行を作れる操作(行追加・行削除)はヘッダセル内では出さない
  const inHeader = editor.isActive('tableHeader');

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
    {
      label: '列を削除',
      onSelect: () => editor.chain().focus().deleteColumn().run(),
    },
    {
      label: '表を削除',
      onSelect: () => editor.chain().focus().deleteTable().run(),
      danger: true,
    },
  );
  return items;
}
