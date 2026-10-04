import {
  InputRule,
  Node,
  PasteRule,
  mergeAttributes,
  textblockTypeInputRule,
} from '@tiptap/core';
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
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

// 貼り付け: 閉じ $ の直後が数字でない (価格誤爆防止)。数式内の \$ は許可
const MATH_INLINE_PASTE_RE =
  /(?<![\\$])\$([^\s$](?:(?:\\[\s\S]|[^$\\\n])*[^\s$])?)\$(?!\d)/g;

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
    const lastDollar = lineTail.lastIndexOf('$$');
    // 閉じ $$ の直前がエスケープされていないか確認
    let endBackslashes = 0;
    let bi = lastDollar - 1;
    while (bi >= 0 && lineTail.charCodeAt(bi) === 0x5c) {
      endBackslashes++;
      bi--;
    }

    if (endBackslashes % 2 === 0) {
      const content = lineTail.slice(0, lastDollar);

      // 内部に未エスケープの $$ が含まれている場合は1行ブロック数式ではない (例: $$a$$ と $$b$$)
      // 行末が $$ で閉じているのに内部に別の $$ がある行は、複数行ブロックの開始でもなく、
      // 複数のインライン数式や通常テキストを含む段落行であるため false を返す
      let hasInnerDollarPair = false;
      let bs = 0;
      for (let ci = 0; ci < content.length; ci++) {
        const ch = content.charCodeAt(ci);
        if (ch === 0x5c) {
          bs++;
        } else if (ch === 0x24) {
          if (ci + 1 < content.length && content.charCodeAt(ci + 1) === 0x24) {
            if (bs % 2 === 0) {
              hasInnerDollarPair = true;
              break;
            }
          }
          bs = 0;
        } else {
          bs = 0;
        }
      }

      if (hasInnerDollarPair) {
        return false;
      }

      if (silent) return true;
      state.line = startLine + 1;

      const token = state.push('math_block', 'pre', 0);
      token.block = true;
      token.content = content + '\n';
      token.map = [startLine, state.line];
      return true;
    }
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
          const latex = match[1];

          // 末尾が奇数個の \ で終わっている場合は閉じ $ がエスケープされているため無効
          let trailingSlashes = 0;
          for (let i = latex.length - 1; i >= 0 && latex.charCodeAt(i) === 0x5c; i--) {
            trailingSlashes++;
          }
          if (trailingSlashes % 2 === 1) return;

          // エスケープされていない $ が含まれている場合は無効
          let backslashes = 0;
          for (let i = 0; i < latex.length; i++) {
            if (latex.charCodeAt(i) === 0x5c) {
              backslashes++;
            } else if (latex.charCodeAt(i) === 0x24) {
              if (backslashes % 2 === 0) return;
              backslashes = 0;
            } else {
              backslashes = 0;
            }
          }

          state.tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ latex }),
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

// 単一ブロック数式テキスト ($$...$$) のパース
export function parseMathBlockContent(text: string): string | null {
  const trimmed = text.trim();
  // 3つ以上の $ で始まるものは除外
  if (!trimmed.startsWith('$$') || trimmed.startsWith('$$$')) return null;
  // $$ で終わっていないものは除外
  if (!trimmed.endsWith('$$') || trimmed.length < 4) return null;
  // "$$$$" の場合（中身が空）
  if (trimmed === '$$$$') return '';

  // 末尾の $$ の直前がエスケープされているか確認（奇数個の \）
  const contentEnd = trimmed.length - 2;
  let backslashes = 0;
  let i = contentEnd - 1;
  while (i >= 0 && trimmed.charCodeAt(i) === 0x5c /* \ */) {
    backslashes++;
    i--;
  }
  if (backslashes % 2 === 1) {
    return null; // \$$ でエスケープされている
  }

  // 中身を取り出す
  let content = trimmed.slice(2, contentEnd);

  // 内部に未エスケープの $$ が含まれている場合は複数ブロックまたは複数ペアのため単一ブロックとみなさない
  let bs = 0;
  for (let idx = 0; idx < content.length; idx++) {
    const ch = content.charCodeAt(idx);
    if (ch === 0x5c /* \ */) {
      bs++;
    } else if (ch === 0x24 /* $ */) {
      if (idx + 1 < content.length && content.charCodeAt(idx + 1) === 0x24) {
        if (bs % 2 === 0) {
          // 未エスケープの $$ を検出
          return null;
        }
      }
      bs = 0;
    } else {
      bs = 0;
    }
  }

  // 前後の改行を1つずつトリム (一般的な $$\n...\n$$ の改行)
  if (content.startsWith('\r\n')) {
    content = content.slice(2);
  } else if (content.startsWith('\n')) {
    content = content.slice(1);
  }
  if (content.endsWith('\r\n')) {
    content = content.slice(0, -2);
  } else if (content.endsWith('\n')) {
    content = content.slice(0, -1);
  }

  return content;
}

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

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('mathBlockPaste'),
        props: {
          handlePaste(view, event, slice) {
            const { state } = view;
            const { selection } = state;

            // コードブロック・数式ブロック・インラインコード内では貼り付けを変換しない
            if (selection.$from.parent.type.spec.code) {
              return false;
            }
            if (rangeHasCodeMark(state, selection.from, selection.to)) {
              return false;
            }

            // 貼り付けテキストの取得 (event または slice から)
            let text = event.clipboardData?.getData('text/plain') ?? '';
            if (!text && slice) {
              text = slice.content.textBetween(0, slice.content.size, '\n');
            }
            if (!text || !text.includes('$$')) return false;

            // 1. テキスト全体が単一のブロック数式の場合
            const singleBlockContent = parseMathBlockContent(text);
            if (singleBlockContent !== null) {
              const mathBlockType = state.schema.nodes.mathBlock;
              if (!mathBlockType) return false;

              const node = mathBlockType.create(
                null,
                singleBlockContent ? state.schema.text(singleBlockContent) : undefined,
              );
              view.dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
              return true;
            }

            // 2. 複数行テキストの中に $$...$$ が含まれている場合
            interface MarkdownStorageLike {
              markdown?: {
                parser?: {
                  parse(content: string, options?: { inline?: boolean }): string;
                };
              };
            }
            const parser = (editor.storage as unknown as MarkdownStorageLike)?.markdown?.parser;
            if (parser && typeof parser.parse === 'function') {
              const html = parser.parse(text);
              if (html && html.includes('data-type="math-block"')) {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = html;
                const parsedSlice = ProseMirrorDOMParser.fromSchema(state.schema).parseSlice(
                  tempDiv,
                  { preserveWhitespace: true },
                );
                if (parsedSlice.content.size > 0) {
                  view.dispatch(state.tr.replaceSelection(parsedSlice).scrollIntoView());
                  return true;
                }
              }
            }

            return false;
          },
        },
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
