import { EditorContent, useEditor } from '@tiptap/react';
import { useState } from 'react';
import { createEditorExtensions } from './markdown';
import './editor.css';

const SAMPLE = `# TsumiWiki エディタ検証

**太字** と *斜体* と ~~打消し~~ が使えます。

- [[リンク先ページ]] へのwikilink
- [[フォルダ/ページ|別名表示]] も対応
- 画像埋め込み ![[screenshot.png]] は記法を保全

> 引用と \`インラインコード\`。本文中の #タグ も保全されます。

\`\`\`mermaid
graph TD
  A --> B
\`\`\`
`;

// 往復変換の目視確認用デモ(左: WYSIWYG編集 / 右: シリアライズ結果)
export function EditorDemo() {
  const [markdown, setMarkdown] = useState('');

  const editor = useEditor({
    extensions: createEditorExtensions(),
    content: SAMPLE,
    onCreate: ({ editor }) => setMarkdown(editor.storage.markdown.getMarkdown() as string),
    onUpdate: ({ editor }) => setMarkdown(editor.storage.markdown.getMarkdown() as string),
  });

  return (
    <div className="editor-demo">
      <section className="pane">
        <h2>WYSIWYG編集(Tiptap)</h2>
        <EditorContent editor={editor} />
      </section>
      <section className="pane">
        <h2>Markdownシリアライズ結果</h2>
        <pre className="markdown-output" data-testid="markdown-output">
          {markdown}
        </pre>
      </section>
    </div>
  );
}
