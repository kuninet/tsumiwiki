import { Editor, type Extensions } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { CodeBlockWithPreview } from './extensions/code-block-view';
import { ObsidianEmbed } from './extensions/embed';
import { ListKeymap } from './extensions/list-keymap';
import { RawBlock } from './extensions/raw-block';
import { Wikilink } from './extensions/wikilink';

export interface EditorExtensionOptions {
  // ReactのNodeView(mermaidプレビュー等)を使うか。
  // ヘッドレス変換(往復テスト・サーバーサイド利用)ではfalseにする。
  nodeViews?: boolean;
}

// エディタ拡張の構成(設計05章)。
// 閲覧・編集・往復変換テストの全てでこの1つの構成を共有する。
export function createEditorExtensions(options: EditorExtensionOptions = {}): Extensions {
  const { nodeViews = true } = options;
  return [
    StarterKit.configure({ codeBlock: false }),
    nodeViews ? CodeBlockWithPreview : CodeBlock,
    Link.configure({ openOnClick: false, autolink: false }),
    Image.configure({ inline: true }), // 段落内画像(![alt](path))を分断しない
    Table, // GFMパイプ表としてシリアライズされる
    TableRow,
    TableHeader,
    TableCell,
    // tiptap-markdownはbulletListにのみtight属性を付与するため、taskListにも同等の
    // 属性を持たせて項目間に空行が入らないようにする(Obsidianのタスクリストは常にtight)
    TaskList.extend({
      addAttributes() {
        return {
          ...this.parent?.(),
          tight: { default: true, rendered: false },
        };
      },
    }),
    TaskItem.configure({ nested: true }),
    Wikilink,
    ObsidianEmbed,
    RawBlock,
    ListKeymap,
    Markdown.configure({
      html: true, // HTMLブロックをrawBlockとして保全するため有効化(raw-block.ts参照)
      tightLists: true,
      linkify: false,
      breaks: false,
    }),
  ];
}

// Markdown→エディタ→Markdownの変換(ヘッドレス)。往復変換テストの対象。
export function roundtripMarkdown(markdown: string): string {
  const editor = new Editor({
    extensions: createEditorExtensions({ nodeViews: false }),
    content: markdown,
  });
  try {
    return editor.storage.markdown.getMarkdown() as string;
  } finally {
    editor.destroy();
  }
}
