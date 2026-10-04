import { InputRule, Node, PasteRule, mergeAttributes } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import {
  escapeHtml,
  type InlineRuleFn,
  type MarkdownItLike,
  type TokenLike,
} from '../markdown-it-types';

// Obsidian互換のwikilink: [[文書名]] / [[文書名|別名]](FR-OBS-02)
// 原文の記法を属性に保持し、シリアライズで完全に復元する。

// 手入力: 閉じ ]] を打った瞬間に変換する。直前が ! の場合は埋め込み側に任せる。
// IME で全角 ［［］］ / ｜ になった場合も半角の wikilink として確定する(findOpener と同じ方針)
const WIKILINK_INPUT_RE =
  /(?<![!！])[[［]{2}([^[\]［］\n|｜]+)(?:[|｜]([^[\]［］\n]+))?[\]］]{2}$/;
// 貼り付け: 半角のみ。全角は原文のまま残す(エスケープされず失われないため)
const WIKILINK_PASTE_RE = /(?<!!)\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g;

function wikilinkAttrs(match: RegExpMatchArray): { target: string; alias: string | null } {
  return { target: match[1], alias: match[2] ?? null };
}

// PasteRule はコードブロックは除外するがインラインコードのマークは見ないため自前で判定する
export function rangeHasCodeMark(state: EditorState, from: number, to: number): boolean {
  let found = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.marks.some((m) => m.type.spec.code)) found = true;
  });
  return found;
}

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

  addInputRules() {
    return [
      // nodeInputRule は match[1] を置換範囲として扱い target 部分だけをノード化してしまうため使わない
      new InputRule({
        find: WIKILINK_INPUT_RE,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create(wikilinkAttrs(match)));
        },
      }),
    ];
  },

  addPasteRules() {
    return [
      new PasteRule({
        find: WIKILINK_PASTE_RE,
        handler: ({ state, range, match }) => {
          // null を返すと同じ貼り付け内の他の変換も破棄されるため、除外は undefined で抜ける
          if (rangeHasCodeMark(state, range.from, range.to)) return;
          state.tr.replaceWith(range.from, range.to, this.type.create(wikilinkAttrs(match)));
        },
      }),
    ];
  },

  // 外部アプリへのコピー(text/plain)と getText() で記法を保つ
  renderText({ node }) {
    const target = node.attrs.target as string;
    const alias = node.attrs.alias as string | null;
    return alias != null ? `[[${target}|${alias}]]` : `[[${target}]]`;
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
