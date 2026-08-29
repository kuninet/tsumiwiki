import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model';

// 「この位置は表の中か」の共通判定(issue #222/#223)。
// DocViewの右クリック判定・表の丸ごと操作の両方がこれを使う(判定の分散を避ける)。
export function findTableAt(
  $pos: ResolvedPos,
): { node: ProseMirrorNode; pos: number; depth: number } | null {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === 'table') {
      return { node, pos: $pos.before(depth), depth };
    }
  }
  return null;
}
