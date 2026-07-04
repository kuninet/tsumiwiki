import { Extension } from '@tiptap/core';

// 空のリスト項目でBackspaceを押したとき、既定のProseMirror動作では
// 「前の項目への段落合体」となり、その後のEnterが「リスト脱出」に消費されて
// 空行が増えない違和感がある(issue #6 のmacOS検証で指摘)。
// Obsidianと同じ操作感(BSでビュレット解除=リスト外の空段落になる)に合わせる。
export const ListKeymap = Extension.create({
  name: 'tsumiwikiListKeymap',
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { empty, $from } = this.editor.state.selection;
        if (!empty || $from.parentOffset !== 0) return false;
        const paragraph = $from.parent;
        if (paragraph.type.name !== 'paragraph' || paragraph.content.size > 0) return false;
        if ($from.depth < 2) return false;
        const item = $from.node(-1);
        if (item.type.name !== 'listItem' && item.type.name !== 'taskItem') return false;
        if (item.childCount !== 1) return false;
        return this.editor.commands.liftListItem(item.type.name);
      },
    };
  },
});
