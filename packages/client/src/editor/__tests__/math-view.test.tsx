import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorExtensions } from '../markdown';

afterEach(cleanup);

function TestEditor({
  content,
  editable = true,
  onEditorReady,
}: {
  content: string;
  editable?: boolean;
  onEditorReady?: (editor: Editor) => void;
}) {
  const editor = useEditor({
    extensions: createEditorExtensions({ nodeViews: true }),
    content,
    editable,
    onCreate: ({ editor: e }) => {
      onEditorReady?.(e);
    },
  });

  if (!editor) return null;
  return <EditorContent editor={editor} />;
}

describe('数式 NodeView (V系)', () => {
  it('V1: ブロック数式外にカーソルがある場合、KaTeX プレビューを表示しソースは非表示', async () => {
    render(<TestEditor content={'前文。\n\n$$\nx^2\n$$'} />);
    await waitFor(() => {
      expect(document.querySelector('.math-block-container')).toBeTruthy();
      expect(document.querySelector('.math-block-preview')).toBeTruthy();
    });
    const pre = document.querySelector('.math-block-view pre') as HTMLElement;
    expect(pre).toBeTruthy();
    expect(pre.style.display).toBe('none');
  });

  it('V2: プレビューをクリックするとソース編集に切り替わりカーソルがブロック内に入る', async () => {
    let activeEditor: Editor | null = null;
    render(
      <TestEditor
        content={'前文。\n\n$$\nx^2\n$$'}
        onEditorReady={(e) => {
          activeEditor = e;
        }}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.math-block-container')).toBeTruthy();
    });

    const container = document.querySelector('.math-block-container') as HTMLElement;
    fireEvent.click(container);

    await waitFor(() => {
      const pre = document.querySelector('.math-block-view pre') as HTMLElement;
      expect(pre.style.display).not.toBe('none');
    });

    if (activeEditor) {
      const { from } = (activeEditor as Editor).state.selection;
      expect(from).toBeGreaterThan(4); // 前文より後ろ(ブロック内)
    }
  });

  it('V3: 構文エラー時はエラーメッセージとソースを表示しエディタは落ちない', async () => {
    render(<TestEditor content={'前文。\n\n$$\n\\frac{\n$$'} />);
    await waitFor(() => {
      expect(document.querySelector('.math-error')).toBeTruthy();
    });
    const errorEl = screen.getByText(/数式エラー:/);
    expect(errorEl).toBeTruthy();
    // M6: HTML実体参照(&#x27;)が含まれていないこと
    expect(errorEl.textContent).not.toContain('&#x27;');
    const source = document.querySelector('.math-error-source') as HTMLElement;
    expect(source).toBeTruthy();
    expect(source.textContent).toContain('\\frac{');
  });

  it('V4: インライン数式をダブルクリック → 編集 → Enter で latex 属性が更新され Markdown に反映', async () => {
    let activeEditor: Editor | null = null;
    render(
      <TestEditor
        content={'式 $x^2$ です。'}
        onEditorReady={(e) => {
          activeEditor = e;
        }}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.math-inline')).toBeTruthy();
    });

    const wrapper = document.querySelector('.math-inline-wrapper') as HTMLElement;
    fireEvent.doubleClick(wrapper);

    await waitFor(() => {
      expect(document.querySelector('.math-inline-input')).toBeTruthy();
    });

    const input = document.querySelector('.math-inline-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'y^3' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(document.querySelector('.math-inline-input')).toBeNull();
    });

    const markdown = activeEditor
      ? ((activeEditor as Editor).storage.markdown.getMarkdown() as string).trim()
      : '';
    expect(markdown).toBe('式 $y^3$ です。');
  });

  it('V5: インライン数式の編集中に Escape を押すと変更が破棄される', async () => {
    let activeEditor: Editor | null = null;
    render(
      <TestEditor
        content={'式 $x^2$ です。'}
        onEditorReady={(e) => {
          activeEditor = e;
        }}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.math-inline')).toBeTruthy();
    });

    const wrapper = document.querySelector('.math-inline-wrapper') as HTMLElement;
    fireEvent.doubleClick(wrapper);

    await waitFor(() => {
      expect(document.querySelector('.math-inline-input')).toBeTruthy();
    });

    const input = document.querySelector('.math-inline-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'changed' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => {
      expect(document.querySelector('.math-inline-input')).toBeNull();
    });

    const markdown = activeEditor
      ? ((activeEditor as Editor).storage.markdown.getMarkdown() as string).trim()
      : '';
    expect(markdown).toBe('式 $x^2$ です。');
  });

  it('V6: 閲覧モードでは編集 UI が出ない', async () => {
    render(<TestEditor content={'式 $x^2$ です。\n\n$$\ny^2\n$$'} editable={false} />);

    await waitFor(() => {
      expect(document.querySelector('.math-inline')).toBeTruthy();
      expect(document.querySelector('.math-block-container')).toBeTruthy();
    });

    const inline = document.querySelector('.math-inline-wrapper') as HTMLElement;
    fireEvent.doubleClick(inline);
    expect(document.querySelector('.math-inline-input')).toBeNull();

    const block = document.querySelector('.math-block-container') as HTMLElement;
    fireEvent.click(block);
    const pre = document.querySelector('.math-block-view pre') as HTMLElement;
    expect(pre.style.display).toBe('none');
  });

  it('V7: \\href{javascript:alert(1)}{x} がリンク化されない (trust: false)', async () => {
    render(<TestEditor content={'$\\href{javascript:alert(1)}{x}$'} />);

    await waitFor(() => {
      expect(document.querySelector('.math-inline-content')).toBeTruthy();
    });

    const anchor = document.querySelector('.math-inline-content a');
    expect(anchor).toBeNull();
  });

  it('V9 (M2): NodeSelection で選択中に Enter を押すと編集モードになり段落分割されない', async () => {
    let activeEditor: Editor | null = null;
    render(
      <TestEditor
        content={'前 $x^2$ 後'}
        onEditorReady={(e) => {
          activeEditor = e;
        }}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.math-inline')).toBeTruthy();
    });

    // mathInline ノードを選択 (pos 3)
    activeEditor!.commands.setNodeSelection(3);
    // Enter キーを実行
    activeEditor!.commands.keyboardShortcut('Enter');

    await waitFor(() => {
      expect(document.querySelector('.math-inline-input')).toBeTruthy();
    });

    // 段落は分割されていない (段落数が 1 のまま)
    expect(activeEditor!.getJSON().content?.length).toBe(1);
  });

  it('V10 (M3): 編集中に input 内をクリックしても入力途中の値がリセットされない', async () => {
    render(<TestEditor content={'式 $x^2$ です。'} />);

    await waitFor(() => {
      expect(document.querySelector('.math-inline')).toBeTruthy();
    });

    const wrapper = document.querySelector('.math-inline-wrapper') as HTMLElement;
    fireEvent.doubleClick(wrapper);

    await waitFor(() => {
      expect(document.querySelector('.math-inline-input')).toBeTruthy();
    });

    const input = document.querySelector('.math-inline-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'draft_value' } });
    expect(input.value).toBe('draft_value');

    // input をクリック
    fireEvent.click(input);
    expect(input.value).toBe('draft_value');
  });

  it('V11 (M4): 確定時に前後の空白が trim されて保存される', async () => {
    let activeEditor: Editor | null = null;
    render(
      <TestEditor
        content={'式 $x^2$ です。'}
        onEditorReady={(e) => {
          activeEditor = e;
        }}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.math-inline')).toBeTruthy();
    });

    const wrapper = document.querySelector('.math-inline-wrapper') as HTMLElement;
    fireEvent.doubleClick(wrapper);

    await waitFor(() => {
      expect(document.querySelector('.math-inline-input')).toBeTruthy();
    });

    const input = document.querySelector('.math-inline-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  y^2   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(document.querySelector('.math-inline-input')).toBeNull();
    });

    const markdown = (activeEditor!.storage.markdown.getMarkdown() as string).trim();
    expect(markdown).toBe('式 $y^2$ です。');
  });

  it('V12 (M7): blur で確定したときはキャレット位置を強制移動しない', async () => {
    let activeEditor: Editor | null = null;
    render(
      <TestEditor
        content={'式 $x^2$ です。長い後続テキスト'}
        onEditorReady={(e) => {
          activeEditor = e;
        }}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.math-inline')).toBeTruthy();
    });

    const wrapper = document.querySelector('.math-inline-wrapper') as HTMLElement;
    fireEvent.doubleClick(wrapper);

    await waitFor(() => {
      expect(document.querySelector('.math-inline-input')).toBeTruthy();
    });

    const input = document.querySelector('.math-inline-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'z^3' } });

    // 本文末尾にキャレットを移動
    const endPos = activeEditor!.state.doc.content.size - 1;
    activeEditor!.commands.setTextSelection(endPos);

    // input が blur
    fireEvent.blur(input);

    await waitFor(() => {
      expect(document.querySelector('.math-inline-input')).toBeNull();
    });

    // キャレットが数式直後(pos 6)に引き戻されず、末尾位置のまま維持されている
    expect(activeEditor!.state.selection.from).toBe(endPos);
  });

  it('V13 (M4): 末尾が奇数個のバックスラッシュで終わる不正な入力は確定を拒否して元の値に戻す', async () => {
    let activeEditor: Editor | null = null;
    render(
      <TestEditor
        content={'式 $x^2$ です。'}
        onEditorReady={(e) => {
          activeEditor = e;
        }}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.math-inline')).toBeTruthy();
    });

    const wrapper = document.querySelector('.math-inline-wrapper') as HTMLElement;
    fireEvent.doubleClick(wrapper);

    await waitFor(() => {
      expect(document.querySelector('.math-inline-input')).toBeTruthy();
    });

    const input = document.querySelector('.math-inline-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a\\' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(document.querySelector('.math-inline-input')).toBeNull();
    });

    // 不正な a\ は確定拒否され、元の x^2 のまま保全される
    const markdown = (activeEditor!.storage.markdown.getMarkdown() as string).trim();
    expect(markdown).toBe('式 $x^2$ です。');
  });

  it('V14 (Issue #276): editable: false から setEditable(true, false) 切り替え後に数式ブロックをクリックするとソース編集が表示される', async () => {
    let activeEditor: Editor | null = null;
    render(
      <TestEditor
        content={'前文。\n\n$$\nx^2\n$$'}
        editable={false}
        onEditorReady={(e) => {
          activeEditor = e;
        }}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.math-block-container')).toBeTruthy();
    });

    const blockContainer = document.querySelector('.math-block-container') as HTMLElement;
    const pre = document.querySelector('.math-block-view pre') as HTMLElement;
    expect(pre.style.display).toBe('none');

    // 閲覧モードではクリックしても編集モードに切り替わらない
    fireEvent.click(blockContainer);
    expect(pre.style.display).toBe('none');

    // 本番(DocView)と同様に emitUpdate=false で編集モードに切り替え、空トランザクションで同期
    activeEditor!.setEditable(true, false);
    activeEditor!.view.dispatch(activeEditor!.state.tr);

    // 編集モードで数式ブロックをクリック
    fireEvent.click(blockContainer);

    await waitFor(() => {
      expect(pre.style.display).not.toBe('none');
    });

    if (activeEditor) {
      const { from } = (activeEditor as Editor).state.selection;
      expect(from).toBeGreaterThan(4);
    }
  });

  it('V15 (Issue #276): 数式編集中に setEditable(false, false) で閲覧モードに戻すとプレビュー表示に復帰する', async () => {
    let activeEditor: Editor | null = null;
    render(
      <TestEditor
        content={'前文。\n\n$$\nx^2\n$$'}
        editable={true}
        onEditorReady={(e) => {
          activeEditor = e;
        }}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.math-block-container')).toBeTruthy();
    });

    const blockContainer = document.querySelector('.math-block-container') as HTMLElement;
    const pre = document.querySelector('.math-block-view pre') as HTMLElement;

    // クリックして編集モードに入る
    fireEvent.click(blockContainer);

    await waitFor(() => {
      expect(pre.style.display).not.toBe('none');
    });

    // 本番(DocView)と同様に emitUpdate=false で閲覧モードに戻し、空トランザクションで同期
    activeEditor!.setEditable(false, false);
    activeEditor!.view.dispatch(activeEditor!.state.tr);

    await waitFor(() => {
      expect(pre.style.display).toBe('none');
    });

    // 閲覧モードなので再度クリックしてもソース編集は開かない
    const containerAfter = document.querySelector('.math-block-container') as HTMLElement;
    expect(containerAfter).toBeTruthy();
    fireEvent.click(containerAfter);
    expect(pre.style.display).toBe('none');
  });
});
