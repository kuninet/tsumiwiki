import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { useRef } from 'react';

// エディタツールバー(FR-EDIT-03・設計05章5.3)。編集モード時のみDocView上部に表示する

interface EditorToolbarProps {
  editor: Editor;
  onOpenLinkDialog: () => void;
  onPickImage: (file: File) => void;
  // #84 Phase C: テンプレート適用モーダルを開く(null なら非表示)
  onOpenTemplateApply?: () => void;
}

interface ToolbarButtonProps {
  label: string;
  title?: string;
  active?: boolean;
  onClick: () => void;
}

function ToolbarButton({ label, title, active, onClick }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={title ?? label}
      aria-pressed={active}
      // mousedownでpreventDefaultし、クリックしてもエディタの選択状態を失わないようにする
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`h-7 min-w-7 whitespace-nowrap rounded px-1.5 text-sm ${
        active ? 'bg-active text-accent' : 'text-ink-soft hover:bg-hoverbg'
      }`}
    >
      {label}
    </button>
  );
}

function Separator() {
  return <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />;
}

export function EditorToolbar({
  editor,
  onOpenLinkDialog,
  onPickImage,
  onOpenTemplateApply,
}: EditorToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 選択範囲の変化(見出し/太字等のトグル状態)にツールバーの表示を追随させる
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      taskList: e.isActive('taskList'),
      codeBlock: e.isActive('codeBlock'),
      blockquote: e.isActive('blockquote'),
      link: e.isActive('link'),
    }),
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onPickImage(file);
    e.target.value = '';
  }

  return (
    <div
      data-testid="editor-toolbar"
      className="flex h-10 flex-wrap items-center gap-1 border-y border-line bg-panel px-4 sm:px-6 lg:px-8"
    >
      <ToolbarButton
        label="H1"
        active={active.h1}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      />
      <ToolbarButton
        label="H2"
        active={active.h2}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      />
      <ToolbarButton
        label="H3"
        active={active.h3}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      />
      <Separator />
      <ToolbarButton
        label="B"
        title="太字"
        active={active.bold}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <ToolbarButton
        label="I"
        title="斜体"
        active={active.italic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <ToolbarButton
        label="S"
        title="打消し"
        active={active.strike}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />
      <Separator />
      <ToolbarButton
        label="•"
        title="箇条書き"
        active={active.bulletList}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <ToolbarButton
        label="1."
        title="番号付きリスト"
        active={active.orderedList}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <ToolbarButton
        label="チェック"
        title="チェックリスト"
        active={active.taskList}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
      />
      <Separator />
      <ToolbarButton
        label="表"
        title="表を挿入(3x3)"
        onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      />
      <ToolbarButton
        label="コード"
        title="コードブロック"
        active={active.codeBlock}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      />
      <ToolbarButton
        label="引用"
        active={active.blockquote}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      />
      <ToolbarButton
        label="区切り線"
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      />
      <Separator />
      <ToolbarButton
        label="リンク"
        title="リンク(Ctrl/Cmd+K)"
        active={active.link}
        onClick={onOpenLinkDialog}
      />
      <ToolbarButton label="画像" onClick={() => fileInputRef.current?.click()} />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp"
        onChange={handleFileChange}
        className="hidden"
      />
      <ToolbarButton
        label="Mermaid"
        onClick={() =>
          editor.chain().focus().insertContent({ type: 'codeBlock', attrs: { language: 'mermaid' } }).run()
        }
      />
      {onOpenTemplateApply && (
        <ToolbarButton
          label="テンプレ適用"
          title="テンプレート適用(挿入/追記)"
          onClick={onOpenTemplateApply}
        />
      )}
    </div>
  );
}
