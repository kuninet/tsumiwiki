import { Editor } from '@tiptap/core';
import { createEditorExtensions } from './markdown';

// #84 Phase C: テンプレを既存文書に挿入するために、Markdown 文字列を
// ProseMirror JSON(のトップレベル content 配列)+ ドキュメント上のサイズ に変換する
// ヘッドレスパーサ。tiptap-markdown の setContent は文書全体を差し替えてしまうので、
// insertContent で使う形の JSON をここで作る。
//
// - content: `editor.commands.insertContent(...)` に渡せるトップレベルノード配列
// - size   : 挿入後のカーソル位置計算に使うドキュメントサイズ。
//            pre/post に分割した Markdown をつなげて挿入する場合、
//            「挿入開始位置 + pre.size」がちょうど pre と post の境界になる。
//            単一 chain / 単一 transaction / 単一 undo で境界カーソルを実現するための情報
//
// 軽微#10: 空文字だけでなく空白のみの Markdown も空扱い(空 paragraph を作らない)。

export interface ParsedMarkdownFragment {
  content: unknown[];
  size: number;
}

export function parseMarkdownFragment(markdown: string): ParsedMarkdownFragment {
  if (!markdown || markdown.trim() === '') return { content: [], size: 0 };
  const headless = new Editor({
    extensions: createEditorExtensions({ nodeViews: false }),
    content: markdown,
  });
  try {
    const json = headless.getJSON() as { content?: unknown[] };
    return {
      content: json.content ?? [],
      size: headless.state.doc.content.size,
    };
  } finally {
    headless.destroy();
  }
}
