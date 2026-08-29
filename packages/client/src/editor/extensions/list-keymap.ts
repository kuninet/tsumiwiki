import { Extension } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';

const LIST_TYPES = ['bulletList', 'orderedList', 'taskList'];
const LIST_ITEM_TYPES = ['listItem', 'taskItem'];

// 空のリスト項目でBackspaceを押したとき、既定のProseMirror動作では
// 「前の項目への段落合体」となり、その後のEnterが「リスト脱出」に消費されて
// 空行が増えない違和感がある(issue #6 のmacOS検証で指摘)。
// Obsidianと同じ操作感(BSでビュレット解除=リスト外の空段落になる)に合わせる。
//
// さらに、リスト直後の空段落でBackspaceすると既定のdeleteBarrierが
// 空段落をlistItemとしてリストに取り込み直し、ビュレットが復活して
// 上記のリスト解除と無限に往復してしまう(issue #220)。Obsidianと同様に
// 「空段落を削除して前のリスト項目の行末へカーソル移動」とする。
// blockquote内やテーブルセル内のリストでも同じ往復が起きるため、
// 深さ固定ではなく「直前の兄弟がリストか」で判定する。
export const ListKeymap = Extension.create({
  name: 'tsumiwikiListKeymap',
  priority: 1000,

  addKeyboardShortcuts() {
    // tiptap既定のKeymapはMod-Backspace等も同じhandleBackspaceに割り当てるため、
    // ここでも同じバリアントに揃えないとビュレット復活経路が残る
    const handleBackspace = () => {
      const { empty, $from } = this.editor.state.selection;
      if (!empty || $from.parentOffset !== 0) return false;
      const paragraph = $from.parent;
      if (paragraph.type.name !== 'paragraph' || paragraph.content.size > 0) return false;

      const container = $from.node(-1);
      if (!LIST_ITEM_TYPES.includes(container.type.name)) {
        // リスト項目外の空段落: 直前の兄弟がリストなら段落を削除して前項目の行末へ
        return this.editor.commands.command(({ tr, dispatch }) => {
          const beforePos = $from.before();
          const nodeBefore = tr.doc.resolve(beforePos).nodeBefore;
          if (!nodeBefore || !LIST_TYPES.includes(nodeBefore.type.name)) return false;
          if (dispatch) {
            tr.delete(beforePos, $from.after());
            // 前項目の末尾がhr等のatomで終わる場合にNodeSelectionへ落ちないよう
            // テキスト位置を優先して探す
            const $before = tr.doc.resolve(beforePos);
            tr.setSelection(Selection.findFrom($before, -1, true) ?? Selection.near($before, -1));
          }
          return true;
        });
      }

      if (container.childCount !== 1) return false;
      return this.editor.commands.liftListItem(container.type.name);
    };

    return {
      Backspace: handleBackspace,
      'Mod-Backspace': handleBackspace,
      'Shift-Backspace': handleBackspace,
    };
  },
});
