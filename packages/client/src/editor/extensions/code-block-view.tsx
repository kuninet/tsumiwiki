import CodeBlock from '@tiptap/extension-code-block';
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import { useEffect, useState } from 'react';

// mermaidコードブロックのNodeView(FR-EDIT-10 / 設計05章5.3)
// - カーソルがブロック外: SVGプレビュー表示
// - カーソルがブロック内: ソース編集表示
// - 構文エラー: エラーメッセージ+ソース表示にフォールバック
// dataview等それ以外の言語は通常のコードブロックのまま(FR-OBS-08)。

import { useCursorInside } from './use-cursor-inside';

let mermaidSeq = 0;

function MermaidPreview({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
        const { svg } = await mermaid.render(`tsumiwiki-mermaid-${++mermaidSeq}`, code);
        if (!cancelled) {
          setSvg(svg);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setSvg(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return <div className="mermaid-error">Mermaid構文エラー: {error}</div>;
  }
  if (!svg) {
    return <div className="mermaid-loading">図を描画中…</div>;
  }
  // securityLevel: 'strict' でレンダリングしたSVGのみを挿入する
  return <div className="mermaid-preview" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function CodeBlockView({ node, editor, getPos }: NodeViewProps) {
  const isMermaid = (node.attrs.language as string | null) === 'mermaid';
  const cursorInside = useCursorInside(editor, getPos, node.nodeSize, isMermaid);
  const showPreview = isMermaid && !cursorInside;

  const focusSource = () => {
    const pos = getPos();
    if (typeof pos === 'number') {
      editor.chain().focus().setTextSelection(pos + 1).run();
    }
  };

  return (
    <NodeViewWrapper className={isMermaid ? 'code-block-view is-mermaid' : 'code-block-view'}>
      {showPreview && (
        <div
          className="mermaid-container"
          onClick={focusSource}
          title="クリックでソースを編集"
          contentEditable={false}
        >
          <MermaidPreview code={node.textContent} />
        </div>
      )}
      {/* contentDOMは常にマウントしたままにする(ProseMirrorの編集整合性のため) */}
      <pre style={showPreview ? { display: 'none' } : undefined}>
        <NodeViewContent as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

export const CodeBlockWithPreview = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
});
