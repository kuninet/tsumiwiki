import { Node } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { escapeHtml, type MarkdownItLike, type TokenLike } from '../markdown-it-types';

// パースできない記法(HTMLブロック等)を原文のまま保全するノード(設計05章5.2)。
// 「読んだものは壊さない」を最優先とし、シリアライズ時は原文を無加工で出力する。

interface SerializerStateLike {
  text(content: string, escape?: boolean): void;
  closeBlock(node: ProseMirrorNode): void;
}

function renderHtmlBlock(tokens: TokenLike[], idx: number): string {
  const content = tokens[idx].content.replace(/\n$/, '');
  return `<pre data-type="raw-block"><code>${escapeHtml(content)}</code></pre>`;
}

// tiptap-markdownのタスクリスト対応(markdown-it-task-lists)が生成するチェックボックスは
// TaskItemノードへの変換に必要なため、エスケープせず通過させる
const TASK_CHECKBOX_RE = /^<input class="task-list-item-checkbox"/;

function renderHtmlInline(tokens: TokenLike[], idx: number): string {
  const content = tokens[idx].content;
  if (TASK_CHECKBOX_RE.test(content)) return content;
  // それ以外のインラインHTML(<br>等)は実行せずプレーンテキストとして保持する
  return escapeHtml(content);
}

export const RawBlock = Node.create({
  name: 'rawBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,

  parseHTML() {
    return [
      {
        tag: 'pre[data-type="raw-block"]',
        preserveWhitespace: 'full',
      },
    ];
  },

  renderHTML() {
    return ['pre', { 'data-type': 'raw-block', class: 'raw-block' }, ['code', 0]];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerStateLike, node: ProseMirrorNode) {
          state.text(node.textContent, false);
          state.closeBlock(node);
        },
        parse: {
          setup(markdownit: MarkdownItLike) {
            markdownit.renderer.rules.html_block = renderHtmlBlock;
            markdownit.renderer.rules.html_inline = renderHtmlInline;
          },
        },
      },
    };
  },
});
