import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditorDemo } from './EditorDemo';

// サンプル文書の mermaid ブロックで本物の mermaid を読み込むと、Mac の初回実行で
// 読み込みだけで数秒かかりタイムアウトする(#339)。このテストはMarkdown出力の保全だけを
// 確かめるので、code-block-view.test.tsx と同じくモックする。
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg data-mermaid-mock="true"></svg>' }),
  },
}));

describe('EditorDemo', () => {
  it('エディタが起動し、サンプルのwikilinkがMarkdown出力に保全される', async () => {
    render(<EditorDemo />);
    // useEditorのエディタ生成は非同期のため、出力が反映されるまで待つ
    await waitFor(() => {
      const output = screen.getByTestId('markdown-output');
      expect(output.textContent).toContain('[[リンク先ページ]]');
      expect(output.textContent).toContain('[[フォルダ/ページ|別名表示]]');
      expect(output.textContent).toContain('![[screenshot.png]]');
      expect(output.textContent).toContain('```mermaid');
    });
  });
});
