import { Editor } from '@tiptap/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorExtensions } from '../editor/markdown';
import { EditorToolbar } from './EditorToolbar';

function createTestEditor(content: string) {
  // focus()コマンドが実際にDOMへフォーカスできるよう、document.bodyへ接続した状態で生成する
  const editor = new Editor({
    extensions: createEditorExtensions({ nodeViews: false }),
    content,
  });
  document.body.appendChild(editor.view.dom);
  return editor;
}

describe('EditorToolbar', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('太字ボタンをクリックするとeditorの太字トグルコマンドが発火する', () => {
    const editor = createTestEditor('本文');
    editor.commands.selectAll();

    render(<EditorToolbar editor={editor} onOpenLinkDialog={vi.fn()} onPickImage={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '太字' }));

    expect(editor.isActive('bold')).toBe(true);

    editor.destroy();
  });

  it('Mermaidボタンをクリックすると空のmermaidコードブロックが挿入される', () => {
    const editor = createTestEditor('');

    render(<EditorToolbar editor={editor} onOpenLinkDialog={vi.fn()} onPickImage={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mermaid' }));

    const markdown = editor.storage.markdown.getMarkdown() as string;
    expect(markdown).toContain('```mermaid');

    editor.destroy();
  });

  it('リンクボタンをクリックするとonOpenLinkDialogが呼ばれる', () => {
    const editor = createTestEditor('本文');
    const onOpenLinkDialog = vi.fn();

    render(<EditorToolbar editor={editor} onOpenLinkDialog={onOpenLinkDialog} onPickImage={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'リンク(Ctrl/Cmd+K)' }));

    expect(onOpenLinkDialog).toHaveBeenCalledTimes(1);

    editor.destroy();
  });

  it('表挿入ボタンをクリックすると3x3の表が挿入される', () => {
    const editor = createTestEditor('');

    render(<EditorToolbar editor={editor} onOpenLinkDialog={vi.fn()} onPickImage={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '表を挿入(3x3)' }));

    expect(editor.isActive('table')).toBe(true);

    editor.destroy();
  });
});
