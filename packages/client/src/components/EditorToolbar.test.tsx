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

    render(
      <EditorToolbar editor={editor} onOpenLinkDialog={onOpenLinkDialog} onPickImage={vi.fn()} />,
    );
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

  it('B/I/Sボタンのラベルが太字/斜体/打消し線で装飾される', () => {
    const editor = createTestEditor('本文');

    render(<EditorToolbar editor={editor} onOpenLinkDialog={vi.fn()} onPickImage={vi.fn()} />);

    const bold = screen.getByRole('button', { name: '太字' });
    const italic = screen.getByRole('button', { name: '斜体' });
    const strike = screen.getByRole('button', { name: '打消し' });
    expect(bold.querySelector('span')?.className).toContain('font-bold');
    expect(italic.querySelector('span')?.className).toContain('italic');
    expect(strike.querySelector('span')?.className).toContain('line-through');

    editor.destroy();
  });

  it('インデント追加/戻しボタンで箇条書き項目のネストがトグルされる', () => {
    const editor = createTestEditor('- 一つ目\n- 二つ目');
    editor.commands.focus('end');

    render(<EditorToolbar editor={editor} onOpenLinkDialog={vi.fn()} onPickImage={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'インデント追加(Tab)' }));
    let markdown = editor.storage.markdown.getMarkdown() as string;
    expect(markdown).toContain('  - 二つ目');

    fireEvent.click(screen.getByRole('button', { name: 'インデント戻し(Shift+Tab)' }));
    markdown = editor.storage.markdown.getMarkdown() as string;
    expect(markdown).not.toContain('  - 二つ目');
    // 行頭一致で確認(部分一致だとネストされた行でも通ってしまうため)
    expect(markdown).toMatch(/^- 二つ目$/m);

    editor.destroy();
  });

  it('インデント追加ボタンの結果はsinkListItemコマンド(Tabキー相当)と同一のMarkdownになる', () => {
    const byButton = createTestEditor('- 一つ目\n- 二つ目');
    byButton.commands.focus('end');
    render(<EditorToolbar editor={byButton} onOpenLinkDialog={vi.fn()} onPickImage={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'インデント追加(Tab)' }));

    // Tabキーマップ(StarterKitのlistItem)が呼ぶコマンドを直接実行した結果と比較する
    const byCommand = createTestEditor('- 一つ目\n- 二つ目');
    byCommand.commands.focus('end');
    byCommand.commands.sinkListItem('listItem');

    expect(byButton.storage.markdown.getMarkdown()).toBe(byCommand.storage.markdown.getMarkdown());

    byButton.destroy();
    byCommand.destroy();
  });

  it('インデント追加ボタンでチェックリスト項目もネストされる', () => {
    const editor = createTestEditor('- [ ] A\n- [ ] B');
    editor.commands.focus('end');

    render(<EditorToolbar editor={editor} onOpenLinkDialog={vi.fn()} onPickImage={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'インデント追加(Tab)' }));

    const markdown = editor.storage.markdown.getMarkdown() as string;
    expect(markdown).toContain('  - [ ] B');

    editor.destroy();
  });

  it('リスト外では インデント追加/戻しボタンがdisabledになる', () => {
    const editor = createTestEditor('本文');
    editor.commands.selectAll();

    render(<EditorToolbar editor={editor} onOpenLinkDialog={vi.fn()} onPickImage={vi.fn()} />);

    expect(
      (screen.getByRole('button', { name: 'インデント追加(Tab)' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'インデント戻し(Shift+Tab)' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    editor.destroy();
  });

  it('ツールバーコンテナは折返しせず横スクロールする', () => {
    const editor = createTestEditor('');

    render(<EditorToolbar editor={editor} onOpenLinkDialog={vi.fn()} onPickImage={vi.fn()} />);
    const container = screen.getByTestId('editor-toolbar');

    // 狭幅時に多段折返しではなく横スクロールで対応する
    expect(container.className).toContain('flex-nowrap');
    expect(container.className).toContain('overflow-x-auto');
    expect(container.className).not.toContain('flex-wrap');

    editor.destroy();
  });

  it('デスクトップ(非タッチ)ではツールバーが通常フローのまま', () => {
    // matchMedia が false = hover 可能なデスクトップ想定
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
        onchange: null,
      })),
    );

    const editor = createTestEditor('');
    render(<EditorToolbar editor={editor} onOpenLinkDialog={vi.fn()} onPickImage={vi.fn()} />);
    const container = screen.getByTestId('editor-toolbar');

    expect(container.dataset.floating).toBe('false');
    expect(container.style.position).toBe('');
    // 通常フロー時はプレースホルダで元の 40px 高さを維持する(#177 FU 回帰防止)
    expect(screen.getByTestId('editor-toolbar-slot').className).toContain('h-10');

    editor.destroy();
    vi.unstubAllGlobals();
  });

  it('タッチ端末で仮想キーボード表示中はツールバーが fixed でキーボード直上に貼り付く', () => {
    // (hover: none) and (pointer: coarse) にマッチさせる
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
        onchange: null,
      })),
    );
    // visualViewport が縮小している = キーボードが出ている状態
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 500,
        offsetTop: 0,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const editor = createTestEditor('');
    render(<EditorToolbar editor={editor} onOpenLinkDialog={vi.fn()} onPickImage={vi.fn()} />);
    const container = screen.getByTestId('editor-toolbar');

    expect(container.dataset.floating).toBe('true');
    expect(container.style.position).toBe('fixed');
    expect(container.style.bottom).toBe('300px');
    // z-index は既存 z-40 群より上、モーダル z-80 より下(#175)
    expect(container.style.zIndex).toBe('45');
    // floating 中はプレースホルダを潰してスクロール可能領域を広げる(#177 FU)
    expect(screen.getByTestId('editor-toolbar-slot').className).toContain('h-0');
    expect(screen.getByTestId('editor-toolbar-slot').className).not.toContain('h-10');

    editor.destroy();
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
  });

  it('タッチ端末でも仮想キーボードが閉じている間はツールバーが通常フロー', () => {
    // 外部キーボード接続時など、visualViewport が縮小していないケース
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
        onchange: null,
      })),
    );
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 800,
        offsetTop: 0,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const editor = createTestEditor('');
    render(<EditorToolbar editor={editor} onOpenLinkDialog={vi.fn()} onPickImage={vi.fn()} />);
    const container = screen.getByTestId('editor-toolbar');

    expect(container.dataset.floating).toBe('false');
    expect(container.style.position).toBe('');
    // 通常フロー時はプレースホルダで元の 40px 高さを維持する(#177 FU 回帰防止)
    expect(screen.getByTestId('editor-toolbar-slot').className).toContain('h-10');

    editor.destroy();
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
  });

  it('ツールバーボタンは pointerdown(touch) で preventDefault し editor blur を防ぐ', () => {
    const editor = createTestEditor('本文');

    render(<EditorToolbar editor={editor} onOpenLinkDialog={vi.fn()} onPickImage={vi.fn()} />);
    const bold = screen.getByRole('button', { name: '太字' });

    // touch: preventDefault される
    const touchEvent = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(touchEvent, 'pointerType', { value: 'touch' });
    bold.dispatchEvent(touchEvent);
    expect(touchEvent.defaultPrevented).toBe(true);

    // mouse: pointerdown では preventDefault されない(mousedown 側で担保する)
    const mouseEvent = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(mouseEvent, 'pointerType', { value: 'mouse' });
    bold.dispatchEvent(mouseEvent);
    expect(mouseEvent.defaultPrevented).toBe(false);

    editor.destroy();
  });
});
