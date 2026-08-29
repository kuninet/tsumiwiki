import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import {
  Braces,
  Code2,
  FileText,
  Image as ImageIcon,
  IndentDecrease,
  IndentIncrease,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Table,
  Workflow,
} from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { useRef } from 'react';
import { useVirtualKeyboard } from '../hooks/use-virtual-keyboard';

// エディタツールバー(FR-EDIT-03・設計05章5.3)。編集モード時のみDocView上部に表示する。
// 狭幅時: `sm` 未満はアイコンのみ、`sm` 以上はアイコン+ラベル。折返しはせず横スクロール。

interface EditorToolbarProps {
  editor: Editor;
  onOpenLinkDialog: () => void;
  onPickImage: (file: File) => void;
  // #84 Phase C: テンプレート適用モーダルを開く(null なら非表示)
  onOpenTemplateApply?: () => void;
  // #224 ソース編集モード: 現在ソース表示中かどうか。トグルボタンのactive表示に使う。
  // 未指定時は「ソース」ボタン自体を表示しない(既存の呼び出し元・テストは非表示のまま)
  sourceMode?: boolean;
  onToggleSourceMode?: () => void;
}

interface ToolbarButtonProps {
  label: string;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon?: ReactNode;
  // ラベル文字自体の装飾(B=太字・I=斜体・S=打消し線など、機能を見た目で示す用)
  labelClassName?: string;
}

function ToolbarButton({
  label,
  title,
  active,
  disabled,
  onClick,
  icon,
  labelClassName,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={title ?? label}
      aria-pressed={active}
      disabled={disabled}
      // mousedown/pointerdownでpreventDefaultし、クリックしてもエディタの選択状態を失わないようにする
      // iOS Safariは `onMouseDown` だけではフォーカス遷移を抑止できず、タッチ操作で editor が blur
      // → 仮想キーボード閉じ → 位置ズレでクリック空振り、が起こるため pointerdown も塞ぐ(#175)。
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.pointerType === 'touch' || e.pointerType === 'pen') e.preventDefault();
      }}
      onClick={onClick}
      className={`flex h-7 min-w-7 flex-shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-sm disabled:opacity-40 ${
        active ? 'bg-active text-accent' : `text-ink-soft ${disabled ? '' : 'hover:bg-hoverbg'}`
      }`}
    >
      {icon}
      {icon ? (
        <span className={['hidden sm:inline', labelClassName].filter(Boolean).join(' ')}>
          {label}
        </span>
      ) : (
        <span className={labelClassName}>{label}</span>
      )}
    </button>
  );
}

function Separator() {
  return <span className="mx-1 h-4 w-px flex-shrink-0 bg-line" aria-hidden="true" />;
}

const ICON_SIZE = 14;

// インデント操作の対象ノード型。taskItem内ではtaskItemを優先し、それ以外はlistItem。
// disabled判定(useEditorState)とonClickで優先順位がズレないようここに集約する
function sinkableListItem(e: Editor): 'taskItem' | 'listItem' | null {
  if (e.can().sinkListItem('taskItem')) return 'taskItem';
  if (e.can().sinkListItem('listItem')) return 'listItem';
  return null;
}

function liftableListItem(e: Editor): 'taskItem' | 'listItem' | null {
  if (e.can().liftListItem('taskItem')) return 'taskItem';
  if (e.can().liftListItem('listItem')) return 'listItem';
  return null;
}

export function EditorToolbar({
  editor,
  onOpenLinkDialog,
  onPickImage,
  onOpenTemplateApply,
  sourceMode = false,
  onToggleSourceMode,
}: EditorToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // #224 ソース編集モード中はWYSIWYG用ボタン(B/I/表など)を操作不能にする。
  // 「ソース」トグル自体は常に押せる(sourceMode解除の唯一の経路のため)
  const wysiwygDisabled = sourceMode;
  // #175: タッチ端末で仮想キーボードが出ている間は、ツールバーをキーボード直上へ貼り付ける。
  // デスクトップ(hover 可 or ポインタ粗くない)は常に通常フロー。
  // z-index 45: 既存の z-40 群(AppShell モバイルドロワー・DropZoneOverlay・SearchBox 等)より
  // 上、モーダル z-80 (PromptDialog/LinkDialog/ConfirmDialog) より下に置く。
  const { visible: floating, bottomOffset } = useVirtualKeyboard();
  const floatingStyle: CSSProperties | undefined = floating
    ? { position: 'fixed', bottom: `${bottomOffset}px`, left: 0, right: 0, zIndex: 45 }
    : undefined;

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
      canIndent: sinkableListItem(e) !== null,
      canOutdent: liftableListItem(e) !== null,
    }),
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onPickImage(file);
    e.target.value = '';
  }

  return (
    // 通常フロー時は 40px の枠を確保するプレースホルダとして機能する。floating 時は
    // 内側が position:fixed で抜けるので、プレースホルダ自体を 0 にしてエディタ本体の
    // スクロール可能領域を広げる(#177 実機フィードバック反映)。
    <div className={floating ? 'h-0 shrink-0' : 'h-10 shrink-0'} data-testid="editor-toolbar-slot">
      <div
        data-testid="editor-toolbar"
        data-floating={String(floating)}
        style={floatingStyle}
        className="flex h-10 flex-nowrap items-center gap-1 overflow-x-auto overscroll-x-contain border-y border-line bg-panel px-4 sm:px-6 lg:px-8"
      >
        <ToolbarButton
          label="H1"
          active={active.h1}
          disabled={wysiwygDisabled}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        />
        <ToolbarButton
          label="H2"
          active={active.h2}
          disabled={wysiwygDisabled}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        />
        <ToolbarButton
          label="H3"
          active={active.h3}
          disabled={wysiwygDisabled}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        />
        <Separator />
        <ToolbarButton
          label="B"
          title="太字"
          labelClassName="font-bold"
          active={active.bold}
          disabled={wysiwygDisabled}
          onClick={() => editor.chain().focus().toggleBold().run()}
        />
        <ToolbarButton
          label="I"
          title="斜体"
          labelClassName="italic"
          active={active.italic}
          disabled={wysiwygDisabled}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        />
        <ToolbarButton
          label="S"
          title="打消し"
          labelClassName="line-through"
          active={active.strike}
          disabled={wysiwygDisabled}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        />
        <Separator />
        <ToolbarButton
          icon={<IndentIncrease size={ICON_SIZE} aria-hidden="true" />}
          label="インデント"
          title="インデント追加(Tab)"
          disabled={wysiwygDisabled || !active.canIndent}
          onClick={() => {
            const type = sinkableListItem(editor);
            if (type) editor.chain().focus().sinkListItem(type).run();
          }}
        />
        <ToolbarButton
          icon={<IndentDecrease size={ICON_SIZE} aria-hidden="true" />}
          label="戻す"
          title="インデント戻し(Shift+Tab)"
          disabled={wysiwygDisabled || !active.canOutdent}
          onClick={() => {
            const type = liftableListItem(editor);
            if (type) editor.chain().focus().liftListItem(type).run();
          }}
        />
        <Separator />
        <ToolbarButton
          icon={<List size={ICON_SIZE} aria-hidden="true" />}
          label="箇条書き"
          title="箇条書き"
          active={active.bulletList}
          disabled={wysiwygDisabled}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        />
        <ToolbarButton
          icon={<ListOrdered size={ICON_SIZE} aria-hidden="true" />}
          label="番号"
          title="番号付きリスト"
          active={active.orderedList}
          disabled={wysiwygDisabled}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        />
        <ToolbarButton
          icon={<ListTodo size={ICON_SIZE} aria-hidden="true" />}
          label="チェック"
          title="チェックリスト"
          active={active.taskList}
          disabled={wysiwygDisabled}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
        />
        <Separator />
        <ToolbarButton
          icon={<Table size={ICON_SIZE} aria-hidden="true" />}
          label="表"
          title="表を挿入(3x3)"
          disabled={wysiwygDisabled}
          onClick={() =>
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          }
        />
        <ToolbarButton
          icon={<Code2 size={ICON_SIZE} aria-hidden="true" />}
          label="コード"
          title="コードブロック"
          active={active.codeBlock}
          disabled={wysiwygDisabled}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        />
        <ToolbarButton
          icon={<Quote size={ICON_SIZE} aria-hidden="true" />}
          label="引用"
          title="引用"
          active={active.blockquote}
          disabled={wysiwygDisabled}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        />
        <ToolbarButton
          icon={<Minus size={ICON_SIZE} aria-hidden="true" />}
          label="区切り線"
          title="区切り線"
          disabled={wysiwygDisabled}
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
        />
        <Separator />
        <ToolbarButton
          icon={<LinkIcon size={ICON_SIZE} aria-hidden="true" />}
          label="リンク"
          title="リンク(Ctrl/Cmd+K)"
          active={active.link}
          disabled={wysiwygDisabled}
          onClick={onOpenLinkDialog}
        />
        <ToolbarButton
          icon={<ImageIcon size={ICON_SIZE} aria-hidden="true" />}
          label="画像/PDF"
          title="画像/PDF"
          disabled={wysiwygDisabled}
          onClick={() => fileInputRef.current?.click()}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp,application/pdf"
          onChange={handleFileChange}
          className="hidden"
        />
        <ToolbarButton
          icon={<Workflow size={ICON_SIZE} aria-hidden="true" />}
          label="Mermaid"
          title="Mermaid"
          disabled={wysiwygDisabled}
          onClick={() =>
            editor
              .chain()
              .focus()
              .insertContent({ type: 'codeBlock', attrs: { language: 'mermaid' } })
              .run()
          }
        />
        {onOpenTemplateApply && (
          <ToolbarButton
            icon={<FileText size={ICON_SIZE} aria-hidden="true" />}
            label="テンプレ適用"
            title="テンプレート適用(挿入/追記)"
            disabled={wysiwygDisabled}
            onClick={onOpenTemplateApply}
          />
        )}
        {onToggleSourceMode && (
          <>
            <Separator />
            <ToolbarButton
              icon={<Braces size={ICON_SIZE} aria-hidden="true" />}
              label="ソース"
              title={sourceMode ? 'WYSIWYG表示に戻す' : 'Markdownソースを編集'}
              active={sourceMode}
              onClick={onToggleSourceMode}
            />
          </>
        )}
      </div>
    </div>
  );
}
