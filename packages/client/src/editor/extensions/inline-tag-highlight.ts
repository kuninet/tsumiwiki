import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

// #77 Phase B: 本文中の `#タグ名` にインラインの装飾を付ける Tiptap 拡張。
// 見た目は editor.css の `.ProseMirror .inline-tag` で定義(チップ風の背景+アクセント色)。
//
// マッチルールはサーバー側 packages/server/src/services/markdown-meta.ts の
// INLINE_TAG_RE = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gmu と揃える。
//   - `#` の直前は 行頭・空白・`(` のいずれか
//   - `#` の後ろは 文字/数字/アンダースコア/`/`/`-` の1文字以上
//   - 数字だけのタグ(例 `#123`)は無視(Obsidian 準拠)
//
// 装飾はDecorationのみで文書構造(Mark)は変えない。round-trip Markdown への影響なし。

const INLINE_TAG_RE = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gmu;
const DIGITS_ONLY_RE = /^[\p{N}/]+$/u;

export const inlineTagPluginKey = new PluginKey<DecorationSet>('inline-tag-highlight');

function computeDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || typeof node.text !== 'string') return;
    // コードブロック内はタグ扱いしない(サーバー側でも stripCode されている)
    const parent = doc.resolve(pos).parent;
    if (parent.type.name === 'codeBlock') return;
    const text = node.text;
    for (const m of text.matchAll(INLINE_TAG_RE)) {
      if (m.index === undefined) continue;
      const tag = m[2];
      if (DIGITS_ONLY_RE.test(tag)) continue;
      // m[0] は先頭区切り(空白等)を含みうるので、`#` の位置を求める
      const hashOffset = m.index + (m[1]?.length ?? 0);
      const start = pos + hashOffset;
      const end = start + 1 + tag.length; // `#` + タグ本体
      decorations.push(Decoration.inline(start, end, { class: 'inline-tag' }));
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const InlineTagHighlight = Extension.create({
  name: 'inlineTagHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: inlineTagPluginKey,
        state: {
          init: (_, { doc }) => computeDecorations(doc),
          apply: (tr, old) => {
            if (!tr.docChanged) return old;
            return computeDecorations(tr.doc);
          },
        },
        props: {
          decorations(state) {
            return inlineTagPluginKey.getState(state);
          },
        },
      }),
    ];
  },
});
