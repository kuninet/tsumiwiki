import { Extension } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';

const LIST_TYPES = ['bulletList', 'orderedList', 'taskList'];

// 空のリスト項目でBackspaceを押したとき、既定のProseMirror動作では
// 「前の項目への段落合体」となり、その後のEnterが「リスト脱出」に消費されて
// 空行が増えない違和感がある(issue #6 のmacOS検証で指摘)。
// Obsidianと同じ操作感(BSでビュレット解除=リスト外の空段落になる)に合わせる。
//
// さらに、リスト直後の空段落でBackspaceすると既定のdeleteBarrierが
// 空段落をlistItemとしてリストに取り込み直し、ビュレットが復活して
// 上記のリスト解除と無限に往復してしまう。Obsidianと同様に
// 「空段落を削除して前のリスト項目の行末へカーソル移動」とする。
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

        // トップレベルの空段落: 直前がリストなら段落を削除して前項目の行末へ
        if ($from.depth === 1) {
          const beforePos = $from.before(1);
          const nodeBefore = this.editor.state.doc.resolve(beforePos).nodeBefore;
          if (!nodeBefore || !LIST_TYPES.includes(nodeBefore.type.name)) return false;
          return this.editor.commands.command(({ tr, dispatch }) => {
            if (dispatch) {
              tr.delete(beforePos, beforePos + paragraph.nodeSize);
              tr.setSelection(Selection.near(tr.doc.resolve(beforePos), -1));
            }
            return true;
          });
        }

        if ($from.depth < 2) return false;
        const item = $from.node(-1);
        if (item.type.name !== 'listItem' && item.type.name !== 'taskItem') return false;
        if (item.childCount !== 1) return false;
        return this.editor.commands.liftListItem(item.type.name);
      },
    };
  },
});
