import type { Editor } from '@tiptap/core';
import type { ContextMenuItem } from '../components/ContextMenu';
import {
  canMoveTableDown,
  canMoveTableUp,
  copyTableToClipboard,
  cutTableToClipboard,
  moveTableDown,
  moveTableUp,
} from './table-block-ops';
import { findTableAt } from './table-utils';

// issue #222: 表のコンテキストメニュー(行/列の追加・削除、表の削除)
// issue #223: 表の丸ごと操作(コピー・カット・上下移動)も同じメニューに載せる
// ロジックをDocViewから切り出した純粋関数。カーソル位置に応じた項目の出し分けはここに集約する。

export interface TableMenuOptions {
  // コピー/カットの結果通知(DocViewがトーストを渡す。テスト等では省略可)
  showToast?: (kind: 'success' | 'error', message: string) => void;
}

export function getTableMenuItems(
  editor: Editor,
  options: TableMenuOptions = {},
): ContextMenuItem[] {
  const { showToast } = options;
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
  items.push(
    {
      label: '表をコピー',
      onSelect: () => {
        // メニューが閉じるとフォーカスがbodyに落ち、直後のCmd+Vが効かなくなるため
        // エディタへフォーカスを戻してからコピーする(#234)
        editor.commands.focus();
        void copyTableToClipboard(editor).then((ok) =>
          showToast?.(ok ? 'success' : 'error', ok ? '表をコピーしました' : 'コピーに失敗しました'),
        );
      },
    },
    {
      label: '表をカット',
      onSelect: () => {
        editor.commands.focus();
        void cutTableToClipboard(editor).then((ok) =>
          showToast?.(ok ? 'success' : 'error', ok ? '表をカットしました' : 'カットに失敗しました'),
        );
      },
    },
  );
  // コンテナの先頭/末尾では移動できず無反応になるため、動かせる方向だけ項目を出す
  if (canMoveTableUp(editor)) {
    items.push({
      label: '表を上へ移動',
      onSelect: () => {
        moveTableUp(editor);
        editor.commands.focus();
      },
    });
  }
  if (canMoveTableDown(editor)) {
    items.push({
      label: '表を下へ移動',
      onSelect: () => {
        moveTableDown(editor);
        editor.commands.focus();
      },
    });
  }
  items.push({
    label: '表を削除',
    onSelect: () => editor.chain().focus().deleteTable().run(),
    danger: true,
  });
  return items;
}
