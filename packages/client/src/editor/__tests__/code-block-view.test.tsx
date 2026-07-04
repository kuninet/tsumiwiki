import { EditorContent, useEditor } from '@tiptap/react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorExtensions } from '../markdown';

// vitestのglobals無効構成ではTesting Libraryの自動cleanupが効かないため明示する
afterEach(cleanup);

// jsdomではmermaidの実レンダリング(SVG計測)ができないためモックする。
// 実際の描画確認は pnpm dev のデモ画面で行う。
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg data-mermaid-mock="true"></svg>' }),
  },
}));

function TestEditor({ content }: { content: string }) {
  const editor = useEditor({ extensions: createEditorExtensions(), content });
  return <EditorContent editor={editor} />;
}

describe('CodeBlockWithPreview', () => {
  it('mermaidブロックはカーソル外でSVGプレビューを表示する', async () => {
    // 先頭に段落を置き、初期カーソルがブロック外にある状態にする
    render(<TestEditor content={'前文。\n\n```mermaid\ngraph TD\n  A --> B\n```'} />);
    await waitFor(() => {
      expect(document.querySelector('.mermaid-preview svg')).toBeTruthy();
    });
    // ソースのpreは非表示(contentDOMはマウントされたまま)
    const pre = document.querySelector('.code-block-view.is-mermaid pre') as HTMLElement;
    expect(pre).toBeTruthy();
    expect(pre.style.display).toBe('none');
  });

  it('mermaid構文エラー時はエラーメッセージにフォールバックする', async () => {
    const mermaid = (await import('mermaid')).default;
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error('Parse error'));
    render(<TestEditor content={'前文。\n\n```mermaid\n!!invalid!!\n```'} />);
    await waitFor(() => {
      expect(screen.getByText(/Mermaid構文エラー/)).toBeTruthy();
    });
  });

  it('dataviewブロックは通常のコードブロックのまま表示する(FR-OBS-08)', async () => {
    render(<TestEditor content={'```dataview\nTABLE file.name FROM #x\n```'} />);
    await waitFor(() => {
      expect(document.querySelector('.code-block-view pre')).toBeTruthy();
    });
    expect(document.querySelector('.mermaid-container')).toBeNull();
    expect(document.body.textContent).toContain('TABLE file.name FROM #x');
  });
});
