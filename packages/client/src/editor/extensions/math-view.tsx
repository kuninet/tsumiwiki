import type React from 'react';
import { NodeSelection } from '@tiptap/pm/state';
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { MathBlock, MathInline } from './math';
import { renderKatex } from './katex-loader';
import { useCursorInside } from './use-cursor-inside';
import { escapeHtml } from '../markdown-it-types';

// 数式(KaTeX / LaTeX)の React NodeView 実装 (FR-EDIT-11 / 設計05章5.3)

// --- ブロック数式 (MathBlockView) ---
function MathBlockPreview({ latex }: { latex: string }) {
  const [rendered, setRendered] = useState<{ html: string; error?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    renderKatex(latex, true)
      .then((res) => {
        if (!cancelled) {
          setRendered(res);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setRendered({
            html: '',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [latex]);

  if (!rendered) {
    return <div className="math-loading">数式を描画中…</div>;
  }

  if (rendered.error) {
    return (
      <div className="math-error-container">
        <div className="math-error">数式エラー: {rendered.error}</div>
        <pre className="math-error-source">
          <code>{latex}</code>
        </pre>
      </div>
    );
  }

  return (
    <div
      className="math-block-preview"
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}

function MathBlockView({ node, editor, getPos }: NodeViewProps) {
  const cursorInside = useCursorInside(editor, getPos, node.nodeSize, editor.isEditable);
  const showPreview = !editor.isEditable || !cursorInside;
  const isEmpty = node.textContent.trim().length === 0;

  const focusSource = () => {
    if (!editor.isEditable) return;
    const pos = getPos();
    if (typeof pos === 'number') {
      editor.chain().focus().setTextSelection(pos + 1).run();
    }
  };

  return (
    <NodeViewWrapper className="math-block-view">
      {showPreview && (
        <div
          className="math-block-container"
          onClick={focusSource}
          title={editor.isEditable ? 'クリックでソースを編集' : undefined}
          contentEditable={false}
        >
          {isEmpty && editor.isEditable ? (
            <div className="math-block-placeholder">数式を入力 ($$)</div>
          ) : (
            <MathBlockPreview latex={node.textContent} />
          )}
        </div>
      )}
      {/* contentDOM は常にマウントしたままにする(ProseMirror の編集整合性のため) */}
      <pre style={showPreview ? { display: 'none' } : undefined}>
        <NodeViewContent as="code" />
      </pre>
      {/* 編集中はソースの下にライブプレビューを併記 */}
      {!showPreview && editor.isEditable && (
        <div className="math-block-live-preview" contentEditable={false}>
          <div className="math-live-preview-header">プレビュー</div>
          <MathBlockPreview latex={node.textContent} />
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const MathBlockWithPreview = MathBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MathBlockView);
  },
});

// --- インライン数式 (MathInlineView) ---
function MathInlineRender({ latex }: { latex: string }) {
  const [rendered, setRendered] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    renderKatex(latex, false)
      .then((res) => {
        if (!cancelled) {
          setRendered(res.html);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRendered(
            `<span class="katex-error" style="color:#cc0000">$${escapeHtml(latex)}$</span>`,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [latex]);

  if (rendered === null) {
    return <span className="math-inline-loading">${latex}$</span>;
  }

  return (
    <span
      className="math-inline-content"
      dangerouslySetInnerHTML={{ __html: rendered }}
    />
  );
}

function MathInlineView({
  node,
  editor,
  getPos,
  selected,
  updateAttributes,
}: NodeViewProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftLatex, setDraftLatex] = useState(node.attrs.latex as string);
  const isSubmittingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 外部からの属性更新に追従
  useEffect(() => {
    if (!isEditing) {
      setDraftLatex(node.attrs.latex as string);
    }
  }, [node.attrs.latex, isEditing]);

  const startEditing = () => {
    if (!editor.isEditable || isEditing) return; // M3: 編集中クリックでのリセット防止
    isSubmittingRef.current = false;
    setDraftLatex(node.attrs.latex as string);
    setIsEditing(true);
  };

  // M2: NodeSelection中のEnterキーによる編集起動イベントの購読
  useEffect(() => {
    const handleEditEvent = (e: Event) => {
      const customEvent = e as CustomEvent<{ pos: number }>;
      const currentPos = getPos();
      if (typeof currentPos === 'number' && customEvent.detail?.pos === currentPos) {
        startEditing();
      }
    };
    editor.view.dom.addEventListener('tsumiwiki:math-inline-edit', handleEditEvent);
    return () => {
      editor.view.dom.removeEventListener('tsumiwiki:math-inline-edit', handleEditEvent);
    };
  });

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const commit = (newLatex: string, moveCursor = false) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setIsEditing(false);
    const pos = getPos();
    if (typeof pos !== 'number') return;
    const trimmed = newLatex.trim();
    if (trimmed === '') {
      editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
      return;
    }

    // 末尾の奇数個の \ をチェック (保存時に \$ となり後続数式を巻き込むデータ破損を防ぐ)
    let trailingBackslashes = 0;
    for (let i = trimmed.length - 1; i >= 0 && trimmed.charCodeAt(i) === 0x5c; i--) {
      trailingBackslashes++;
    }

    // エスケープされていない $ や改行を含んでいるかチェック
    let hasUnescapedDollar = false;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed.charCodeAt(i) === 0x24) {
        let bs = 0;
        for (let j = i - 1; j >= 0 && trimmed.charCodeAt(j) === 0x5c; j--) {
          bs++;
        }
        if (bs % 2 === 0) {
          hasUnescapedDollar = true;
          break;
        }
      }
    }

    const isInvalid =
      trailingBackslashes % 2 === 1 ||
      hasUnescapedDollar ||
      trimmed.includes('\n');

    if (isInvalid) {
      // 不正な値のときは確定を拒否し、直前の値にリセット
      setDraftLatex(node.attrs.latex as string);
      if (moveCursor) {
        editor.chain().focus().setTextSelection(pos + node.nodeSize).run();
      }
      return;
    }

    // M4: trimmed値で更新。値に変化がなければ余計な更新を行わない
    if (trimmed !== node.attrs.latex) {
      updateAttributes({ latex: trimmed });
    }
    // M7: Enterでの確定時のみカーソルをノード直後へ移動。blur時は他操作を阻害しないよう位置維持
    if (moveCursor) {
      editor.chain().focus().setTextSelection(pos + node.nodeSize).run();
    }
  };

  const cancel = () => {
    isSubmittingRef.current = true;
    setIsEditing(false);
    setDraftLatex(node.attrs.latex as string);
    // m2: Escape破棄時はエディタへフォーカスを復帰
    editor.commands.focus();
  };

  return (
    <NodeViewWrapper
      as="span"
      className={`math-inline-wrapper ${selected ? 'is-selected' : ''}`}
      onDoubleClick={startEditing}
      onClick={startEditing}
      tabIndex={editor.isEditable ? 0 : undefined}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (!isEditing && e.key === 'Enter') {
          e.preventDefault();
          startEditing();
        }
      }}
    >
      {isEditing ? (
        <span
          className="math-inline-edit"
          contentEditable={false}
          onClick={(e) => e.stopPropagation()} // M3: クリックイベントのバブリング防止
        >
          <input
            ref={inputRef}
            type="text"
            className="math-inline-input"
            value={draftLatex}
            onChange={(e) => setDraftLatex(e.target.value)}
            onClick={(e) => e.stopPropagation()} // M3
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                commit(draftLatex, true); // Enter確定時はmoveCursor: true
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
            onBlur={() => {
              commit(draftLatex, false); // M7: blur確定時はmoveCursor: false
            }}
          />
          <span className="math-inline-preview-tooltip">
            <MathInlineRender latex={draftLatex} />
          </span>
        </span>
      ) : (
        <span
          className="math-inline"
          title={editor.isEditable ? 'ダブルクリックで編集' : undefined}
        >
          <MathInlineRender latex={node.attrs.latex as string} />
        </span>
      )}
    </NodeViewWrapper>
  );
}

export const MathInlineWithPreview = MathInline.extend({
  // M2: NodeSelection状態でEnterを押した際に編集モードへ入るショートカット
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { selection } = this.editor.state;
        if (selection instanceof NodeSelection && selection.node.type === this.type) {
          this.editor.view.dom.dispatchEvent(
            new CustomEvent('tsumiwiki:math-inline-edit', {
              detail: { pos: selection.from },
            }),
          );
          return true; // ProseMirror既定のEnter(段落分割)を防止
        }
        return false;
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathInlineView);
  },
});
