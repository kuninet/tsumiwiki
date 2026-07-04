import { Node, mergeAttributes } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  escapeHtml,
  type InlineRuleFn,
  type MarkdownItLike,
  type TokenLike,
} from '../markdown-it-types';

// Obsidian互換のwikilink: [[文書名]] / [[文書名|別名]](FR-OBS-02)
// 原文の記法を属性に保持し、シリアライズで完全に復元する。

interface SerializerStateLike {
  write(content: string): void;
}

const wikilinkRule: InlineRuleFn = (state, silent) => {
  const { src, pos } = state;
  if (!src.startsWith('[[', pos)) return false;
  const end = src.indexOf(']]', pos + 2);
  if (end < 0 || end >= state.posMax) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner || /[[\]\n]/.test(inner)) return false;

  if (!silent) {
    const pipe = inner.indexOf('|');
    const target = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const alias = pipe >= 0 ? inner.slice(pipe + 1) : null;
    const token = state.push('wikilink', '', 0);
    token.meta = { target, alias };
  }
  state.pos = end + 2;
  return true;
};

function renderWikilink(tokens: TokenLike[], idx: number): string {
  const meta = tokens[idx].meta ?? {};
  const target = meta.target ?? '';
  const alias = meta.alias;
  const aliasAttr = alias != null ? ` data-alias="${escapeHtml(alias)}"` : '';
  return `<span data-type="wikilink" data-target="${escapeHtml(target)}"${aliasAttr}></span>`;
}

export const Wikilink = Node.create({
  name: 'wikilink',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      target: { default: '' },
      alias: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="wikilink"]',
        getAttrs: (el) => ({
          target: (el as HTMLElement).getAttribute('data-target') ?? '',
          alias: (el as HTMLElement).getAttribute('data-alias'),
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const label = (node.attrs.alias as string | null) ?? (node.attrs.target as string);
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'wikilink',
        'data-target': node.attrs.target as string,
        'data-alias': (node.attrs.alias as string | null) ?? undefined,
        class: 'wikilink',
      }),
      label,
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerStateLike, node: ProseMirrorNode) {
          const target = node.attrs.target as string;
          const alias = node.attrs.alias as string | null;
          state.write(alias != null ? `[[${target}|${alias}]]` : `[[${target}]]`);
        },
        parse: {
          setup(markdownit: MarkdownItLike) {
            markdownit.inline.ruler.before('link', 'wikilink', wikilinkRule);
            markdownit.renderer.rules.wikilink = renderWikilink;
          },
        },
      },
    };
  },
});
