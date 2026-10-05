import type { Editor } from '@tiptap/core';
import { useEffect, useState } from 'react';

// エディタ内のカーソル(選択範囲)が対象ノードの内側にあるかを判定するフック。
// CodeBlockView(Mermaid) と MathBlockView で共有する。
export function useCursorInside(
  editor: Editor,
  getPos: () => number | undefined,
  nodeSize: number,
  enabled = true,
): boolean {
  const [cursorInside, setCursorInside] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setCursorInside(false);
      return;
    }
    const update = () => {
      const pos = getPos();
      if (typeof pos !== 'number') return;
      const { from, to } = editor.state.selection;
      setCursorInside(editor.isEditable && from >= pos && to <= pos + nodeSize);
    };
    update();
    editor.on('transaction', update);
    editor.on('update', update);
    editor.on('selectionUpdate', update);
    editor.on('focus', update);
    editor.on('blur', update);
    return () => {
      editor.off('transaction', update);
      editor.off('update', update);
      editor.off('selectionUpdate', update);
      editor.off('focus', update);
      editor.off('blur', update);
    };
  }, [editor, getPos, nodeSize, enabled]);

  return cursorInside;
}
