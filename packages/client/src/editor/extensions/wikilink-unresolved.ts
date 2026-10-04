import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { buildWikilinkResolver, parseWikilinkTarget, type DocSummary } from '@tsumiwiki/shared';

// issue #266: 未解決リンク(リンク先が存在しないwikilink)に
// is-unresolved クラスと title 属性を付与する ProseMirror デコレーションプラグイン。
//
// Wikilinkノード自体をNodeView化せず、Decoration.nodeでクラスと属性を付加することで
// atomノードの選択・編集・キー操作などの既存挙動を維持する。

export const wikilinkUnresolvedPluginKey = new PluginKey<DecorationSet>('wikilink-unresolved');
export const WIKILINK_DOCS_CHANGED_META = 'wikilink-docs-changed';

export interface WikilinkUnresolvedOptions {
  getDocs: () => readonly DocSummary[];
}

function computeDecorations(
  doc: ProseMirrorNode,
  resolver: (target: string) => string | null,
): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'wikilink') return;
    const rawTarget = (node.attrs.target as string) ?? '';
    const meta = parseWikilinkTarget(rawTarget);
    // 自文書内リンク([[#見出し]]等)は未解決にしない
    if (meta.isInternal || !meta.target) return;

    const resolved = resolver(rawTarget);
    if (resolved === null) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: 'is-unresolved',
          title: 'リンク先が存在しません',
        }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const WikilinkUnresolved = Extension.create<WikilinkUnresolvedOptions>({
  name: 'wikilinkUnresolved',

  addOptions() {
    return {
      getDocs: () => [],
    };
  },

  addProseMirrorPlugins() {
    const getDocs = this.options.getDocs;
    // getDocs()が返す配列の参照をキーにしてリゾルバインスタンスをキャッシュ(キー入力ごとの再生成を防止)
    const resolverCache = new WeakMap<readonly DocSummary[], (target: string) => string | null>();

    const getResolver = (): ((target: string) => string | null) => {
      const docs = getDocs();
      let resolver = resolverCache.get(docs);
      if (!resolver) {
        resolver = buildWikilinkResolver(docs);
        resolverCache.set(docs, resolver);
      }
      return resolver;
    };

    return [
      new Plugin<DecorationSet>({
        key: wikilinkUnresolvedPluginKey,
        state: {
          init: (_, { doc }) => {
            return computeDecorations(doc, getResolver());
          },
          apply: (tr, old, _oldState, newState) => {
            const docsChanged = Boolean(tr.getMeta(WIKILINK_DOCS_CHANGED_META));
            if (!tr.docChanged && !docsChanged) {
              return old.map(tr.mapping, tr.doc);
            }
            return computeDecorations(newState.doc, getResolver());
          },
        },
        props: {
          decorations(state) {
            return wikilinkUnresolvedPluginKey.getState(state);
          },
        },
      }),
    ];
  },
});
