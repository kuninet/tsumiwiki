import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { withHeadlessEditor } from './markdown';
import { findTableAt } from './table-utils';

// 表ブロックの丸ごと操作(コピー・カット・上下移動)。issue #223。
// メニューUI(table-menu.ts / components/)への配線はここでは行わない。

// カーソル位置から最も近い祖先の table ノードを探す。表外なら null。
// pos は table ノードの開始位置(表の直前)。
export function findParentTable(editor: Editor): { node: ProseMirrorNode; pos: number } | null {
  return findTableAt(editor.state.selection.$from);
}

// 表ノード単体をヘッドレスエディタに包んでGFM Markdownへシリアライズする
function serializeTableNode(node: ProseMirrorNode): string {
  return withHeadlessEditor(
    { type: 'doc', content: [node.toJSON()] },
    (tmp) => tmp.storage.markdown.getMarkdown() as string,
  );
}

// カーソルを含む表をGFM Markdownへシリアライズする。表外なら null。
export function serializeTableToMarkdown(editor: Editor): string | null {
  const found = findParentTable(editor);
  if (!found) return null;
  return serializeTableNode(found.node);
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

  // await中(クリップボードの権限プロンプト等)に文書が変わっていると、コピー前に
  // 取った位置が別範囲を指して本文を破損しうる。削除直前に取り直して同一の表か確認する
  const still = findParentTable(editor);
  if (!still || still.node !== found.node) return false;

  const { node, pos } = still;
  return editor
    .chain()
    .focus()
    .deleteRange({ from: pos, to: pos + node.nodeSize })
    .run();
}

// 表を上/下へ動かせるか(親コンテナ内に隣接する兄弟ブロックがあるか)。
// メニューの項目出し分け(table-menu.ts)と moveTable の実行判定を同じ条件に揃えるための関数。
export function canMoveTableUp(editor: Editor): boolean {
  const found = findParentTable(editor);
  return !!found && !!editor.state.doc.resolve(found.pos).nodeBefore;
}

export function canMoveTableDown(editor: Editor): boolean {
  const found = findParentTable(editor);
  return !!found && !!editor.state.doc.resolve(found.pos + found.node.nodeSize).nodeAfter;
}

// 表ブロックを直前/直後の兄弟ブロックと入れ替える共通実装。
// 「表を削除して兄弟の前後に挿入し直す」を1トランザクションで行い、undoが1回で戻るようにする。
// 兄弟は表の直接の親コンテナ内(doc直下とは限らない。blockquote内等も含む)で探す。
function moveTable(editor: Editor, direction: 'up' | 'down'): boolean {
  const found = findParentTable(editor);
  if (!found) return false;
  const { node: tableNode, pos: tableStart } = found;
  const tableEnd = tableStart + tableNode.nodeSize;
  // 移動後も編集中のセルにカーソルを保つため、表内の相対位置を控えておく
  // (表の内容は移動で変わらないため、新しい表開始位置+同じオフセットが同じセルを指す)
  const selOffset = Math.min(
    Math.max(editor.state.selection.from - tableStart, 1),
    tableNode.nodeSize - 1,
  );

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
        const $cursor = tr.doc.resolve(prevStart + selOffset);
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
      const $cursor = tr.doc.resolve(newTablePos + selOffset);
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
