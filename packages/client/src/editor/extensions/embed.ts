import { InputRule, Node, PasteRule, mergeAttributes } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  escapeHtml,
  type InlineRuleFn,
  type MarkdownItLike,
  type TokenLike,
} from '../markdown-it-types';
import { rangeHasCodeMark } from './wikilink';

// Obsidian互換の埋め込み: ![[ファイル名]](FR-OBS-03)
// プロトタイプでは記法の保全(往復変換)のみを対象とし、
// 画像としての表示解決(/api/files経由)は本実装で行う。

// 手入力は全角 ！［［］］ も半角の埋め込みとして確定する。target は |幅 等を含むため | を許す(embedRule と同じ)
const EMBED_INPUT_RE = /[!！][[［]{2}([^[\]［］\n]+)[\]］]{2}$/;
const EMBED_PASTE_RE = /!\[\[([^[\]\n]+)\]\]/g;

interface SerializerStateLike {
  write(content: string): void;
}

const embedRule: InlineRuleFn = (state, silent) => {
  const { src, pos } = state;
  if (!src.startsWith('![[', pos)) return false;
  const end = src.indexOf(']]', pos + 3);
  if (end < 0 || end >= state.posMax) return false;
  const target = src.slice(pos + 3, end);
  if (!target || /[[\]\n]/.test(target)) return false;

  if (!silent) {
    const token = state.push('obsidian_embed', '', 0);
    token.meta = { target };
  }
  state.pos = end + 2;
  return true;
};

function renderEmbed(tokens: TokenLike[], idx: number): string {
  const target = tokens[idx].meta?.target ?? '';
  return `<span data-type="obsidian-embed" data-target="${escapeHtml(target)}"></span>`;
}

export const ObsidianEmbed = Node.create({
  name: 'obsidianEmbed',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      target: { default: '' },
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: EMBED_INPUT_RE,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create({ target: match[1] }));
        },
      }),
    ];
  },

  addPasteRules() {
    return [
      new PasteRule({
        find: EMBED_PASTE_RE,
        handler: ({ state, range, match }) => {
          if (rangeHasCodeMark(state, range.from, range.to)) return;
          state.tr.replaceWith(range.from, range.to, this.type.create({ target: match[1] }));
        },
      }),
    ];
  },

  renderText({ node }) {
    return `![[${node.attrs.target as string}]]`;
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="obsidian-embed"]',
        getAttrs: (el) => ({
          target: (el as HTMLElement).getAttribute('data-target') ?? '',
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'obsidian-embed',
        'data-target': node.attrs.target as string,
        class: 'obsidian-embed',
      }),
      `![[${node.attrs.target as string}]]`,
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerStateLike, node: ProseMirrorNode) {
          state.write(`![[${node.attrs.target as string}]]`);
        },
        parse: {
          setup(markdownit: MarkdownItLike) {
            markdownit.inline.ruler.before('image', 'obsidian_embed', embedRule);
            markdownit.renderer.rules.obsidian_embed = renderEmbed;
          },
        },
      },
    };
  },
});
