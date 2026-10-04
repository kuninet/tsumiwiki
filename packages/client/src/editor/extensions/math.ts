import {
  InputRule,
  Node,
  PasteRule,
  mergeAttributes,
  textblockTypeInputRule,
} from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  escapeHtml,
  type BlockRuleFn,
  type InlineRuleFn,
  type MarkdownItLike,
  type TokenLike,
} from '../markdown-it-types';
import { rangeHasCodeMark } from './wikilink';

// 数式レンダリング機能(KaTeX / LaTeX)(FR-EDIT-11 / 設計05章5.3)
// MathInline: $...$ のインライン数式 (atomノード)
// MathBlock: $$...$$ のブロック数式 (text* / code: true)

// 手入力: 閉じ $ を打った瞬間に変換する
const MATH_INLINE_INPUT_RE = /(?<![\\$])\$([^\s$](?:[^$\n]*[^\s$])?)\$$/;

// 貼り付け: 閉じ $ の直後が数字でない (価格誤爆防止)
const MATH_INLINE_PASTE_RE = /(?<![\\$])\$([^\s$](?:[^$\n]*[^\s$])?)\$(?!\d)/g;

interface SerializerStateLike {
  write(content: string): void;
  text(content: string, escape?: boolean): void;
  ensureNewLine(): void;
  closeBlock(node: ProseMirrorNode): void;
}

// Pandocのtex_math_dollarsと同じ区切り規則
export const mathInlineRule: InlineRuleFn = (state, silent) => {
  const { src, pos, posMax } = state;
  if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;

  // 直前が \ でない (奇数個のバックスラッシュならエスケープされている)
  let backslashes = 0;
  let p = pos - 1;
  while (p >= 0 && src.charCodeAt(p) === 0x5c /* \ */) {
    backslashes++;
    p--;
  }
  if (backslashes % 2 === 1) return false;

  // $$ で始まる場合はインラインとして扱わない
  if (pos + 1 < posMax && src.charCodeAt(pos + 1) === 0x24) return false;

  // 開き $ の直後が空白でない
  if (pos + 1 >= posMax) return false;
  const nextChar = src.charAt(pos + 1);
  if (/\s/.test(nextChar)) return false;

  // 閉じ $ を探す (改行を含まない)
  let end = -1;
  let i = pos + 1;
  while (i < posMax) {
    const ch = src.charCodeAt(i);
    if (ch === 0x0a /* \n */) return false;
    if (ch === 0x5c /* \ */) {
      // \ の次の文字をスキップ
      i += 2;
      continue;
    }
    if (ch === 0x24 /* $ */) {
      // 閉じ $ の直前が空白でない
      if (!/\s/.test(src.charAt(i - 1))) {
        // 閉じ $ の直後が数字でない
        const afterClose = i + 1 < posMax ? src.charAt(i + 1) : '';
        if (!/\d/.test(afterClose)) {
          end = i;
          break;
        }
      }
    }
    i++;
  }

  if (end < 0) return false;

  const latex = src.slice(pos + 1, end);
  if (!latex) return false;

  if (!silent) {
    const token = state.push('math_inline', '', 0);
    token.meta = { latex };
  }
  state.pos = end + 1;
  return true;
};

export function renderMathInline(tokens: TokenLike[], idx: number): string {
  const meta = tokens[idx].meta ?? {};
  const latex = meta.latex ?? '';
  return `<span data-type="math-inline" data-latex="${escapeHtml(latex)}">$${escapeHtml(latex)}$</span>`;
}

export const mathBlockRule: BlockRuleFn = (state, startLine, endLine, silent) => {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];

  // インデントが4スペース以上の場合は通常のインデントコードブロック
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;

  if (pos + 2 > max) return false;

  // $$ で始まっているか
  if (state.src.charCodeAt(pos) !== 0x24 || state.src.charCodeAt(pos + 1) !== 0x24) {
    return false;
  }

  // 3つ以上の $ で始まっている場合は対象外
  if (pos + 2 < max && state.src.charCodeAt(pos + 2) === 0x24) {
    return false;
  }

  // 1行形式 $$x$$ の判定
  const lineTail = state.src.slice(pos + 2, max);
  const trimmedTail = lineTail.trim();
  if (trimmedTail.length >= 2 && trimmedTail.endsWith('$$')) {
    if (silent) return true;
    const lastDollar = lineTail.lastIndexOf('$$');
    const content = lineTail.slice(0, lastDollar);
    state.line = startLine + 1;

    const token = state.push('math_block', 'pre', 0);
    token.block = true;
    token.content = content + '\n';
    token.map = [startLine, state.line];
    return true;
  }

  // 複数行形式
  if (silent) return true;

  const firstLineRest = lineTail.trim() !== '' ? lineTail : '';

  let nextLine = startLine;
  let haveEndMarker = false;
  let closingLineContent: string | null = null;

  for (;;) {
    nextLine++;
    if (nextLine >= endLine) {
      break;
    }

    pos = state.bMarks[nextLine] + state.tShift[nextLine];
    max = state.eMarks[nextLine];

    if (pos < max && state.sCount[nextLine] < state.blkIndent) {
      break;
    }

    // パターンA: 行頭(インデント後)が $$ で始まっていて、後ろが空白のみ
    if (
      state.src.charCodeAt(pos) === 0x24 &&
      state.src.charCodeAt(pos + 1) === 0x24 &&
      state.sCount[nextLine] - state.blkIndent < 4
    ) {
      let afterClose = pos + 2;
      while (
        afterClose < max &&
        (state.src.charCodeAt(afterClose) === 0x20 || state.src.charCodeAt(afterClose) === 0x09)
      ) {
        afterClose++;
      }
      if (afterClose >= max) {
        haveEndMarker = true;
        closingLineContent = null;
        break;
      }
    }

    // パターンB: 行末が $$ で終わっている (直前が \ でない)
    // 例: "x $$" や "\end{aligned} $$" (リスト項目内の相対インデントも保持)
    const lineContent = state.src.slice(pos, max);
    const trimmedLine = lineContent.trimEnd();
    if (trimmedLine.endsWith('$$') && trimmedLine.length >= 2) {
      const dollarIndex = trimmedLine.length - 2;
      let backslashes = 0;
      let bi = dollarIndex - 1;
      while (bi >= 0 && trimmedLine.charCodeAt(bi) === 0x5c) {
        backslashes++;
        bi--;
      }
      if (backslashes % 2 === 0) {
        haveEndMarker = true;
        // blkIndent分のみを取り除いた行を取得して末尾の $$ を除去し、リスト内の相対インデントを保持する
        const fullLine = state.getLines(nextLine, nextLine + 1, state.blkIndent, false);
        const lastDollar = fullLine.lastIndexOf('$$');
        closingLineContent = fullLine.slice(0, lastDollar);
        break;
      }
    }
  }

  let content = '';
  if (firstLineRest) {
    content += firstLineRest + '\n';
  }
  const lines = state.getLines(startLine + 1, nextLine, state.blkIndent, true);
  content += lines;
  if (closingLineContent !== null) {
    content += closingLineContent.trimEnd() + '\n';
  }

  state.line = nextLine + (haveEndMarker ? 1 : 0);

  const token = state.push('math_block', 'pre', 0);
  token.block = true;
  token.content = content;
  token.map = [startLine, state.line];
  return true;
};

export function renderMathBlock(tokens: TokenLike[], idx: number): string {
  const content = tokens[idx].content.replace(/\n$/, '');
  return `<pre data-type="math-block"><code>${escapeHtml(content)}</code></pre>`;
}

export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      latex: { default: '' },
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: MATH_INLINE_INPUT_RE,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ latex: match[1] }),
          );
        },
      }),
    ];
  },

  addPasteRules() {
    return [
      new PasteRule({
        find: MATH_INLINE_PASTE_RE,
        handler: ({ state, range, match }) => {
          if (rangeHasCodeMark(state, range.from, range.to)) return;
          state.tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ latex: match[1] }),
          );
        },
      }),
    ];
  },

  renderText({ node }) {
    const latex = node.attrs.latex as string;
    return `$${latex}$`;
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="math-inline"]',
        getAttrs: (el) => ({
          latex: (el as HTMLElement).getAttribute('data-latex') ?? '',
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const latex = node.attrs.latex as string;
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'math-inline',
        'data-latex': latex,
        class: 'math-inline',
      }),
      `$${latex}$`,
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerStateLike, node: ProseMirrorNode) {
          const latex = node.attrs.latex as string;
          state.write(`$${latex}$`);
        },
        parse: {
          setup(markdownit: MarkdownItLike) {
            markdownit.inline.ruler.before('escape', 'math_inline', mathInlineRule);
            markdownit.renderer.rules.math_inline = renderMathInline;
          },
        },
      },
    };
  },
});

export const MathBlock = Node.create({
  name: 'mathBlock',
  priority: 1000,
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,

  addInputRules() {
    return [
      textblockTypeInputRule({
        find: /^\$\$[\s\n]$/,
        type: this.type,
      }),
    ];
  },

  parseHTML() {
    return [
      {
        tag: 'pre[data-type="math-block"]',
        preserveWhitespace: 'full',
      },
    ];
  },

  renderHTML() {
    return ['pre', { 'data-type': 'math-block', class: 'math-block' }, ['code', 0]];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerStateLike, node: ProseMirrorNode) {
          state.write('$$\n');
          state.text(node.textContent, false);
          state.ensureNewLine();
          state.write('$$');
          state.closeBlock(node);
        },
        parse: {
          setup(markdownit: MarkdownItLike) {
            markdownit.block.ruler.before('fence', 'math_block', mathBlockRule, {
              alt: ['paragraph', 'reference', 'blockquote', 'list'],
            });
            markdownit.renderer.rules.math_block = renderMathBlock;
          },
        },
      },
    };
  },
});
