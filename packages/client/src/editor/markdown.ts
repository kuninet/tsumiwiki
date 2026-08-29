import { type Content, Editor, type Extensions } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';
import Image from '@tiptap/extension-image';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import StarterKit from '@tiptap/starter-kit';
import type { DocSummary } from '@tsumiwiki/shared';
import { Markdown } from 'tiptap-markdown';
import { CodeBlockWithPreview } from './extensions/code-block-view';
import { HardBreakMarkdown } from './extensions/hard-break-markdown';
import { ObsidianEmbed } from './extensions/embed';
import { ObsidianEmbedWithPreview } from './extensions/embed-view';
import { ImageWithResolvedSrc } from './extensions/image-view';
import { InlineTagHighlight } from './extensions/inline-tag-highlight';
import { LinkWithTitle, MarkdownLinkSchemes } from './extensions/link-markdown';
import { ListKeymap } from './extensions/list-keymap';
import { RawBlock } from './extensions/raw-block';
import { Wikilink } from './extensions/wikilink';
import { WikilinkSuggestion } from './extensions/wikilink-suggestion';

export interface EditorExtensionOptions {
  // ReactのNodeView(mermaidプレビュー・画像表示解決等)を使うか。
  // ヘッドレス変換(往復テスト・サーバーサイド利用)ではfalseにする。
  nodeViews?: boolean;
  // [[入力補完の候補文書。DocViewがuseTreeの結果を渡す(省略時は補完なし)
  getWikilinkDocs?: () => DocSummary[];
}

// エディタ拡張の構成(設計05章)。
// 閲覧・編集・往復変換テストの全てでこの1つの構成を共有する。
export function createEditorExtensions(options: EditorExtensionOptions = {}): Extensions {
  const { nodeViews = true, getWikilinkDocs } = options;
  return [
    StarterKit.configure({ codeBlock: false, hardBreak: false }),
    // 表セル内・見出し内のhardBreakを安全にシリアライズする置き換え(#229)
    HardBreakMarkdown,
    nodeViews ? CodeBlockWithPreview : CodeBlock,
    // 相対パス・title・file: を往復で落とさないリンク(issue #207。link-markdown.ts 参照)
    LinkWithTitle,
    MarkdownLinkSchemes,
    // 段落内画像(![alt](path))を分断しない。NodeViewは表示解決のみでシリアライズには無関係
    (nodeViews ? ImageWithResolvedSrc : Image).configure({ inline: true }),
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
    nodeViews ? ObsidianEmbedWithPreview : ObsidianEmbed,
    RawBlock,
    ListKeymap,
    InlineTagHighlight,
    WikilinkSuggestion.configure({ getDocs: getWikilinkDocs ?? (() => []) }),
    Markdown.configure({
      html: true, // HTMLブロックをrawBlockとして保全するため有効化(raw-block.ts参照)
      tightLists: true,
      linkify: false,
      breaks: false,
    }),
  ];
}

// ヘッドレスエディタを一時生成して変換処理を行う共通ヘルパー(必ずdestroyする)
export function withHeadlessEditor<T>(content: Content, fn: (editor: Editor) => T): T {
  const editor = new Editor({
    extensions: createEditorExtensions({ nodeViews: false }),
    content,
  });
  try {
    return fn(editor);
  } finally {
    editor.destroy();
  }
}

// Markdown→エディタ→Markdownの変換(ヘッドレス)。往復変換テストの対象。
export function roundtripMarkdown(markdown: string): string {
  return withHeadlessEditor(markdown, (editor) => editor.storage.markdown.getMarkdown() as string);
}
