import { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { createEditorExtensions } from './markdown';

// 表ブロックの丸ごと操作(コピー・カット・上下移動)。issue #223。
// メニューUI(table-menu.ts / components/)への配線はここでは行わない。

// カーソル位置から最も近い祖先の table ノードを探す。表外なら null。
// 位置は $from.before(depth) = table ノードの開始位置(表の直前)。
export function findParentTable(editor: Editor): { node: ProseMirrorNode; pos: number } | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'table') {
      return { node, pos: $from.before(depth) };
    }
  }
  return null;
}

// 表ノード単体をヘッドレスエディタに包んでGFM Markdownへシリアライズする
// (markdown.ts の roundtripMarkdown と同じパターン)。表外なら null。
export function serializeTableToMarkdown(editor: Editor): string | null {
  const found = findParentTable(editor);
  if (!found) return null;

  const tmp = new Editor({
    extensions: createEditorExtensions({ nodeViews: false }),
    content: { type: 'doc', content: [found.node.toJSON()] },
  });
  try {
    return tmp.storage.markdown.getMarkdown() as string;
  } finally {
    tmp.destroy();
  }
}

// 表をGFM Markdownとしてクリップボードへコピーする。
// クリップボードAPIが使えない・拒否された場合は例外を投げずfalseを返す。
export async function copyTableToClipboard(editor: Editor): Promise<boolean> {
  const markdown = serializeTableToMarkdown(editor);
  if (markdown === null) return false;

  try {
    await navigator.clipboard.writeText(markdown);
    return true;
  } catch {
    return false;
  }
}

// 表をコピーしたうえで文書から削除する。コピーに失敗した場合は
// (クリップボードへ渡せなかった内容を失わないよう)削除も行わずfalseを返す。
export async function cutTableToClipboard(editor: Editor): Promise<boolean> {
  const found = findParentTable(editor);
  if (!found) return false;

  const copied = await copyTableToClipboard(editor);
  if (!copied) return false;

  const { node, pos } = found;
  return editor
    .chain()
    .focus()
    .deleteRange({ from: pos, to: pos + node.nodeSize })
    .run();
}

// 表ブロックを直前/直後の兄弟ブロックと入れ替える共通実装。
// 「表を削除して兄弟の前後に挿入し直す」を1トランザクションで行い、undoが1回で戻るようにする。
// 兄弟は表の直接の親コンテナ内(doc直下とは限らない。blockquote内等も含む)で探す。
function moveTable(editor: Editor, direction: 'up' | 'down'): boolean {
  const found = findParentTable(editor);
  if (!found) return false;
  const { node: tableNode, pos: tableStart } = found;
  const tableEnd = tableStart + tableNode.nodeSize;

  return editor.commands.command(({ tr, dispatch }) => {
    if (direction === 'up') {
      const prevSibling = tr.doc.resolve(tableStart).nodeBefore;
      if (!prevSibling) return false; // 既にコンテナの先頭

      if (dispatch) {
        // 兄弟の開始位置は表の削除(表より前)の影響を受けないため、
        // 削除前に計算した位置をそのまま挿入先に使える
        const prevStart = tableStart - prevSibling.nodeSize;
        tr.delete(tableStart, tableEnd);
        tr.insert(prevStart, tableNode);
        const $cursor = tr.doc.resolve(prevStart + 1);
        tr.setSelection(TextSelection.near($cursor, 1));
      }
      return true;
    }

    const nextSibling = tr.doc.resolve(tableEnd).nodeAfter;
    if (!nextSibling) return false; // 既にコンテナの末尾

    if (dispatch) {
      const nextEnd = tableEnd + nextSibling.nodeSize;
      tr.delete(tableStart, tableEnd);
      // 削除で兄弟が表のサイズ分手前にずれるため、その分を差し引いた位置が新しい挿入先
      const newTablePos = nextEnd - tableNode.nodeSize;
      tr.insert(newTablePos, tableNode);
      const $cursor = tr.doc.resolve(newTablePos + 1);
      tr.setSelection(TextSelection.near($cursor, 1));
    }
    return true;
  });
}

export function moveTableUp(editor: Editor): boolean {
  return moveTable(editor, 'up');
}

export function moveTableDown(editor: Editor): boolean {
  return moveTable(editor, 'down');
}
